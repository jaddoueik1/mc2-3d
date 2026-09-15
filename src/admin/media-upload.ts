export type PrivateUploadGrant = {
  privateBucket: string;
  privateKey: string;
  expiresAt: string;
};

// The API grants a path, not an upload token. Supabase verifies the signed session
// JWT and evaluates the exact-path, unexpired, unclaimed grant in Storage RLS.
export async function uploadPrivateMedia(options: {
  supabaseUrl: string;
  publishableKey: string;
  accessToken: string;
  grant: PrivateUploadGrant;
  file: Blob;
  mimeType: 'model/gltf-binary' | 'image/png' | 'image/jpeg' | 'image/webp';
  fetcher?: typeof fetch;
}): Promise<void> {
  const { grant } = options;
  if (!options.accessToken || grant.privateBucket !== 'cms-media-private'
    || !/^private\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(grant.privateKey)
    || !Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= Date.now()) {
    throw new Error('A current authenticated private upload grant is required.');
  }
  const response = await (options.fetcher ?? fetch)(
    options.supabaseUrl.replace(/\/$/, '') + '/storage/v1/object/' + grant.privateBucket + '/' + grant.privateKey,
    {
      method: 'POST',
      headers: {
        apikey: options.publishableKey,
        authorization: 'Bearer ' + options.accessToken,
        'content-type': options.mimeType,
        'x-upsert': 'false',
      },
      body: options.file,
    },
  );
  if (!response.ok) throw new Error('Private upload failed (' + response.status + ').');
}
