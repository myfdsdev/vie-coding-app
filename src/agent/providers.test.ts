import { describe, expect, it } from 'vitest';
import { readableProviderError } from './providers';

describe('readableProviderError', () => {
  it('unwraps the JSON-in-JSON error the Gemini SDK throws for a retired model', () => {
    // Same shape as the real message: the API's pretty-printed error body,
    // wrapped by the SDK in a second JSON envelope.
    const apiBody = JSON.stringify(
      { error: { code: 404, message: 'This model models/gemini-2.5-pro is no longer available to new users.', status: 'NOT_FOUND' } },
      null,
      2,
    );
    const sdkMessage = JSON.stringify({ error: { message: `${apiBody}\n`, code: 404, status: 'Not Found' } });
    expect(readableProviderError(sdkMessage)).toBe('This model models/gemini-2.5-pro is no longer available to new users.');
  });

  it('leaves plain messages alone', () => {
    expect(readableProviderError('fetch failed')).toBe('fetch failed');
  });

  it('leaves JSON without an error message alone', () => {
    expect(readableProviderError('{"status":"UNAVAILABLE"}')).toBe('{"status":"UNAVAILABLE"}');
  });
});
