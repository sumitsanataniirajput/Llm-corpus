/* ========================================
   CORPUS ULTIMATE — Device compute worker

   This file runs in a real Web Worker: it is created by js/device-agent.js and
   is the only place where device CPU work happens, so the page never freezes
   while a device tokenizes a dataset shard.

   It does exactly two things, both measurable:
     tokenize  — split a real text shard into tokens and report how far it got
     benchmark — measure this device's real tokenizer throughput

   Nothing here guesses: every number in a message is counted or timed locally,
   and the caller decides what to display.
   ======================================== */
'use strict';

const PROGRESS_INTERVAL_MS = 250;

/**
 * Deterministic word/punctuation tokenizer.
 *
 * Mirrors the shape of the backend's tokenizer closely enough for counting
 * work (words, numbers and single punctuation marks become tokens). It is not
 * claimed to be the model's vocabulary — the coordinator only sums the counts.
 */
function countTokens(text, startsInsideWord) {
  let tokens = 0;
  let inWord = !!startsInsideWord;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    const isSpace = code === 32 || code === 9 || code === 10 || code === 13;
    if (isSpace) {
      inWord = false;
      continue;
    }
    const isPunctuation = code < 48
      || (code > 57 && code < 65)
      || (code > 90 && code < 97)
      || (code > 122 && code < 128);
    if (isPunctuation) {
      tokens += 1;
      inWord = false;
      continue;
    }
    if (!inWord) {
      tokens += 1;
      inWord = true;
    }
  }
  return { tokens: tokens, endsInsideWord: inWord };
}

function nowMs() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

/** Tokenize `text` in slices, reporting progress between them. */
function runTokenize(message) {
  const text = typeof message.text === 'string' ? message.text : '';
  const chunkChars = Math.max(1024, Number(message.chunkChars) || 65536);
  // Tests and very small shards can ask for one report per slice; during real
  // work the reports are coalesced so the main thread is not flooded.
  const progressInterval = message.progressIntervalMs === undefined
    ? PROGRESS_INTERVAL_MS
    : Math.max(0, Number(message.progressIntervalMs));
  const total = text.length;
  const started = nowMs();
  let offset = 0;
  let tokens = 0;
  let insideWord = false;
  let lastReport = started;

  while (offset < total) {
    const end = Math.min(total, offset + chunkChars);
    // A word split across two slices must count as one token, not two.
    const slice = countTokens(text.slice(offset, end), insideWord);
    tokens += slice.tokens;
    insideWord = slice.endsInsideWord;
    offset = end;
    const stamp = nowMs();
    if (stamp - lastReport >= progressInterval || offset >= total) {
      lastReport = stamp;
      self.postMessage({
        type: 'progress',
        taskId: message.taskId || null,
        processedChars: offset,
        totalChars: total,
        tokens: tokens,
        elapsedMs: Math.round(stamp - started),
      });
    }
  }

  const elapsedMs = Math.max(1, nowMs() - started);
  self.postMessage({
    type: 'result',
    taskId: message.taskId || null,
    tokens: tokens,
    characters: total,
    elapsedMs: Math.round(elapsedMs),
    charactersPerSecond: Math.round(total / (elapsedMs / 1000)),
  });
}

/** Measure this device's real tokenizer throughput on generated text. */
function runBenchmark(message) {
  const sampleWords = [
    'corpus', 'ultimate', 'training', 'device', 'tokenizer', 'gradient',
    'dataset', 'checkpoint', 'worker', 'progress', 'model', 'context',
  ];
  const targetChars = Math.max(20000, Number(message.chars) || 400000);
  let sample = '';
  let seed = 1234567;
  while (sample.length < targetChars) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    sample += sampleWords[seed % sampleWords.length] + (seed % 7 === 0 ? '.\n' : ' ');
  }
  const started = nowMs();
  const tokens = countTokens(sample, false).tokens;
  const elapsedMs = Math.max(1, nowMs() - started);
  self.postMessage({
    type: 'benchmark',
    characters: sample.length,
    tokens: tokens,
    elapsedMs: Math.round(elapsedMs),
    charactersPerSecond: Math.round(sample.length / (elapsedMs / 1000)),
    tokensPerSecond: Math.round(tokens / (elapsedMs / 1000)),
  });
}

self.onmessage = function onmessage(event) {
  const message = event && event.data ? event.data : {};
  try {
    if (message.type === 'tokenize') {
      runTokenize(message);
    } else if (message.type === 'benchmark') {
      runBenchmark(message);
    } else {
      self.postMessage({ type: 'error', message: 'Unknown worker request: ' + String(message.type) });
    }
  } catch (err) {
    // A device that runs out of memory or fails mid-shard reports the real
    // error so the page can show it instead of spinning forever.
    self.postMessage({
      type: 'error',
      taskId: message.taskId || null,
      message: (err && err.message) ? err.message : String(err),
    });
  }
};
