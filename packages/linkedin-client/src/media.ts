import { LinkedInError } from './errors.js';
import type { LinkedInHttp } from './http.js';
import {
  InitializeUploadResponse,
  type ImageUrn,
  type MemberUrn,
} from './types.js';

/**
 * Image upload. Two steps, in order:
 *
 *   1. POST /rest/images?action=initializeUpload  → uploadUrl + image URN
 *   2. PUT the bytes to uploadUrl                 → 201
 *
 * The returned URN is then referenced in the post body. Skipping step 1 and
 * PUTting to a guessed URL does not work; the upload URL is single-use and
 * signed.
 *
 * Video (/rest/videos) follows the same shape but adds chunked upload for
 * large files. Not implemented in v1 — the content engine is text-first and
 * nothing generates video yet. Add it when something does.
 */
export class Media {
  constructor(private readonly http: LinkedInHttp) {}

  async uploadImage(args: {
    accountId: string;
    accessToken: string;
    owner: MemberUrn;
    bytes: Uint8Array;
    contentType: string;
  }): Promise<ImageUrn> {
    const init = await this.http.request({
      method: 'POST',
      path: '/images?action=initializeUpload',
      accessToken: args.accessToken,
      accountId: args.accountId,
      // Counts against the write budget: it reserves an asset server-side.
      isWrite: true,
      body: { initializeUploadRequest: { owner: args.owner } },
    });

    const parsed = InitializeUploadResponse.safeParse(safeJson(init.text));
    if (!parsed.success) {
      throw new LinkedInError(
        `Unrecognised initializeUpload response: ${parsed.error.message}`,
        { status: init.status, endpoint: '/images', body: init.text },
      );
    }

    const { uploadUrl, image } = parsed.data.value;

    // The upload URL is a signed, single-use endpoint on a different host. It
    // takes no LinkedIn-Version header and no Authorization — passing them is
    // harmless on some CDNs and a 400 on others, so we send neither.
    await this.http.request({
      method: 'PUT',
      path: '/images:upload',
      absoluteUrl: uploadUrl,
      accountId: args.accountId,
      isWrite: false, // the reservation already counted; the PUT is the same op
      headers: { 'Content-Type': args.contentType },
      rawBody: args.bytes,
    });

    return image;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
