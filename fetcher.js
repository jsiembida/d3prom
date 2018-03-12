


function Metadata(obj) {
    const keys = Object.getOwnPropertyNames(obj).filter(k => !k.startsWith("__") && k !== 'job');
    keys.sort();
    this.metadata = {};
    keys.forEach(k => this.metadata[k] = obj[k]);
    this.hash = Array.from(keys, k => "" + k + "=" + obj[k]).join(', ');
    Object.freeze(this.metadata);
    Object.freeze(this);
}



function PrometheusFetcher(prometheusUrls) {
    this.prometheusUrls = prometheusUrls;
}


PrometheusFetcher.prototype.mergeResponses = function(responseBuffer, start, end, callback) {

    if (responseBuffer.length !== this.prometheusUrls.length) return;

    const mergeSamples = (samplesBuffer, samples) => {
        samples.forEach(sample => {
            const t = 1000 * sample[0];
            const v = +sample[1];
            samplesBuffer.set(t, v);
        });
    };

    const mergeMetric = (mergeBuffer, response) => {
        if (response.status !== 'success') return;

        response.data.result.forEach(metric => {
            const metadata = new Metadata(metric.metric);
            var samplesBuffer = mergeBuffer.get(metadata.hash);
            if (samplesBuffer === undefined) {
                samplesBuffer = new Map();
                mergeBuffer.set(metadata.hash, samplesBuffer);
            }
            mergeSamples(samplesBuffer, metric.values);
        });
    };

    // We merge only after receiving something from all endpoints.
    // That is to be able to use consistent merging order (which will be implemented later).
    const mergeBuffer = new Map();
    responseBuffer.forEach(response => {
        if (response == null) return;
        mergeMetric(mergeBuffer, response);
    });

    callback(mergeBuffer, start, end);
}


PrometheusFetcher.prototype.fetchQuery = function(query, start, end, step, callback) {

    const responseBuffer = [];

    const success = (e) => {
        responseBuffer.push(JSON.parse(e.target.responseText));
        this.mergeResponses(responseBuffer, start, end, callback);
    };

    const error = (e) => {
        responseBuffer.push(null);
        this.mergeResponses(responseBuffer, start, end, callback);
    };

    const fetchFromOneEndpoint = (url) => {
        const xhr = new XMLHttpRequest();
        xhr.abort = xhr.error = xhr.timeout = error;
        xhr.onload = success;
        xhr.open('GET', url);
        xhr.send(null);
    };

    const queryString = '?query=' + encodeURIComponent('' + query)
                + '&start=' + encodeURIComponent('' + (start / 1000))
                + '&end=' + encodeURIComponent('' + (end / 1000))
                + '&step=' + encodeURIComponent('' + (step / 1000) + 's');

    this.prometheusUrls.forEach(url => fetchFromOneEndpoint(url + '/api/v1/query_range' + queryString));
}




// Uniqueness of the query is defined by the query itself and a step.
// Time slices is what we cache for the tuple of the two.
function QueryCache(prometheusFetcher, prometheusQuery, queryStep) {
    this.prometheusFetcher = prometheusFetcher;
    this.prometheusQuery = prometheusQuery;
    this.queryStep = queryStep;
    this.maxSliceSize = 100;
    // slice: {start: startTimestamp, end: endTimestamp: metrics: metricsMap}
    // metrics: {id1: samples1, id2: samples2, ...}
    // samples: {t1: v1, t2: v2, ...}
    this.slices = [];  // Kept sorted by time
};


QueryCache.prototype.sortSlices = function() {
    this.slices.sort((a, b) => (a.start > b.start) ? 1 : ((a.start < b.start) ? -1 : 0));
};


QueryCache.prototype.mergeSlices = function(sliceA, sliceB) {
    const result = {
        start: Math.min(sliceA.start, sliceB.start),
        end: Math.max(sliceA.end, sliceB.end),
        metrics: new Map(sliceA.metrics)
    };

    sliceB.metrics.forEach((metricSamples, metricId) => {
        const samples = result.metrics.get(metricId);
        if (samples === undefined) {
            result.metrics.set(metricId, metricSamples);
        } else {
            metricSamples.forEach((v, t) => samples.set(t, v));
        }
    });

    return result;
}


QueryCache.prototype.compactSlices = function() {
    if (this.slices.length < 2) return;

    this.sortSlices();

    const result = [];
    var curr = this.slices[0];
    const maxGap = this.queryStep * 1.8;
    for(var i = 1; i < this.slices.length; i++) {
        const currSize = (curr.end - curr.start) / this.queryStep;
        const next = this.slices[i];
        const nextSize = (next.end - next.start) / this.queryStep;

        if (next.start < curr.end + maxGap && currSize + nextSize < this.maxSliceSize) {
            curr = this.mergeSlices(curr, next);
        } else {
            result.push(curr);
            curr = next;
        }
    }
    result.push(curr);

    this.slices = result;
}


QueryCache.prototype.get = function(start, end, callback) {
    const result = new Map();

    const addMetric = (metricSamples, metricId) => {
        var samples = result.get(metricId);
        if (samples === undefined) {
            samples = new Map()
            result.set(metricId, samples);
        }
        metricSamples.forEach((v, t) => {
            if (t >= start && t <= end) {
                samples.set(t, v);
            }
        });
    }

    for(const slice of this.slices) {
        if ((slice.start >= start && slice.start <= end) || (slice.end >= start && slice.end <= end)) {
            slice.metrics.forEach(addMetric);
            start = slice.end + this.queryStep;
        }

        if (start >= end) break;
    }

    if (start < end) {
        this.prometheusFetcher.fetchQuery(this.prometheusQuery, start, end, this.queryStep, (metrics, start, end) => {
            console.log('fetched', start, end);
            this.slices.push({
                start: start,
                end: end,
                metrics: metrics
            });
            metrics.forEach(addMetric);
            this.compactSlices();
            callback(result);
        });
    } else {
        callback(result);
    }
};
