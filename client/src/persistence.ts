import { rememberedCredentials, rememberCredentials } from './credentials';

let allowed = !!rememberedCredentials();
const listeners = new Set<(allowed: boolean) => void>();
export const persistenceAllowed = () => allowed;
export function onPersistenceChange(listener: (allowed: boolean) => void) {
  listeners.add(listener);
}
export function setPersistenceAllowed(value: boolean) {
  allowed = value;
  if (!value) {
    try {
      rememberCredentials('', '', false);
      for (const name of ['foxwq_time_control', 'foxwq_coordinates'])
        document.cookie = `${name}=; Max-Age=0; Path=/; SameSite=Strict${location.protocol === 'https:' ? '; Secure' : ''}`;
    } catch {}
  }
  for (const listener of listeners) listener(value);
}
