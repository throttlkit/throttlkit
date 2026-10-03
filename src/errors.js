export class ThrottlCapacityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ThrottlCapacityError';
  }
}

export class ThrottlStoreError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'ThrottlStoreError';
  }
}

export class ThrottlConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ThrottlConfigurationError';
  }
}

export class ThrottlTimeoutError extends ThrottlStoreError {
  constructor(message = 'Rate-limit operation timed out') {
    super(message);
    this.name = 'ThrottlTimeoutError';
  }
}
