/** Raised when a market data provider cannot return usable data: bad status, timeout, malformed
 * payload, or missing credentials. */
export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderError';
  }
}
