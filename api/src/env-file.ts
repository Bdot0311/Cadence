import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const ENV_KEY = /^[A-Z][A-Z0-9_]*$/;

export function updateEnvText(source: string, values: Record<string, string>): string {
  const remaining = new Map(Object.entries(values));
  const lines = source.split(/\r?\n/).map((line) => {
    const match = line.match(/^([A-Z][A-Z0-9_]*)\s*=/);
    if (!match) return line;
    const key = match[1] as string;
    const value = remaining.get(key);
    if (value === undefined) return line;
    remaining.delete(key);
    return `${key}=${quoteEnv(value)}`;
  });

  while (lines.at(-1) === '') lines.pop();
  for (const [key, value] of remaining) {
    if (!ENV_KEY.test(key)) throw new Error(`Invalid environment key: ${key}`);
    lines.push(`${key}=${quoteEnv(value)}`);
  }
  return `${lines.join('\n')}\n`;
}

export async function writeEnvFile(path: string, values: Record<string, string>): Promise<void> {
  for (const value of Object.values(values)) {
    if (/[\r\n]/.test(value)) throw new Error('Environment values cannot contain newlines');
  }
  let current = '';
  try { current = await readFile(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, updateEnvText(current, values), { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

function quoteEnv(value: string): string {
  return JSON.stringify(value);
}
