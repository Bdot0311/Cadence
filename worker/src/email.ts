export interface Mailer {
  send(subject: string, text: string): Promise<void>;
}

export function createMailer(config: {
  apiKey?: string; to?: string; from?: string;
}): Mailer {
  return {
    async send(subject, text) {
      if (!config.apiKey || !config.to || !config.from) {
        console.warn(`[email skipped] ${subject}\n${text}`);
        return;
      }
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ from: config.from, to: [config.to], subject, text }),
      });
      if (!response.ok) throw new Error(`Resend failed (${response.status}): ${await response.text()}`);
    },
  };
}
