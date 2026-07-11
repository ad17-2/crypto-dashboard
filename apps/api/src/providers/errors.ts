/** Port of crypto_screener/providers.py::ProviderError -- raised when a market data provider
 * cannot return usable data (bad status, timeout, malformed payload, missing credentials). */
export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderError';
  }
}
