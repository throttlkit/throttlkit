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
