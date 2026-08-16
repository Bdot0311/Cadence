import { describe, expect, it } from 'vitest';
import { updateEnvText } from './env-file.js';

describe('updateEnvText', () => {
  it('preserves unrelated lines and replaces credentials without duplicates', () => {
    const result = updateEnvText('# local\nLINKEDIN_CLIENT_ID=old\nSUPABASE_URL=https://example.supabase.co\n', {
      LINKEDIN_CLIENT_ID: 'new-id',
      LINKEDIN_CLIENT_SECRET: 'secret#with spaces',
    });
    expect(result).toContain('# local\n');
    expect(result).toContain('SUPABASE_URL=https://example.supabase.co\n');
    expect(result).toContain('LINKEDIN_CLIENT_ID="new-id"\n');
    expect(result).toContain('LINKEDIN_CLIENT_SECRET="secret#with spaces"\n');
    expect(result.match(/LINKEDIN_CLIENT_ID=/g)).toHaveLength(1);
  });
});
