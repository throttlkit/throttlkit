import throttle = require('throttlflow');
import core = require('throttlflow/core');
const limiter = throttle({ limit: 2, windowMs: 1000 });
const result: Promise<throttle.ThrottlDecision> = limiter.check('u', { cost: 2 });
void result;
void throttle.memoryStore();
void core({ algorithm: 'gcra', limit: 10, windowMs: 1000, burst: 2 });
