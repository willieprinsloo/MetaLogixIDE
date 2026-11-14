import { useEffect, useState } from 'react';
import { api } from '../api';

/**
 * This machine's P2P device name, read once from `p2p:settings-get`. Returns '' while the call is
 * pending, when the name is unset, and when the call rejects (it does with `p2p_not_started` while
 * P2P is off); the spec resolves all three to the "This machine" fallback in `buildMachineList`.
 */
export function useSelfDeviceName(): string {
  const [name, setName] = useState('');
  useEffect(() => {
    api.invoke('p2p:settings-get', undefined).then(
      (s) => setName(typeof s.deviceName === 'string' ? s.deviceName : ''),
      () => setName(''),
    );
  }, []);
  return name;
}
