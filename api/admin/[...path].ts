import { requireCapability } from '../../server/auth.ts';
import {
  createMediaAdminHandler,
  createMediaService,
  createSupabaseMediaDependencies,
} from '../../server/media.ts';

const handler = createMediaAdminHandler({
  service: createMediaService(createSupabaseMediaDependencies()),
  requireCapability,
});

export default async function adminMedia(request: Request): Promise<Response> {
  return handler(request);
}
