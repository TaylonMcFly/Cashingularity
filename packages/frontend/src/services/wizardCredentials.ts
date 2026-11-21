/** Only WizardConnect relay credentials. The wallet's keys never leave its device. */
export interface WizardCredentials {
  privateKey: string;
  secret: string;
  walletPublicKey: string;
  walletName: string;
  receiveAddress: string;
  changeAddress: string;
  receiveXpub?: string;
  changeXpub?: string;
}

export interface SavedWizardProfile {
  id: string;
  name: string;
}

interface EncryptedPairing {
  profile?: SavedWizardProfile;
  key: CryptoKey;
  iv: Uint8Array<ArrayBuffer>;
  data: ArrayBuffer;
  peer: string;
}

const database = 'cashingularity.wizard-relay.v1';
const storeName = 'pairings';
const legacyRecord = 'last-approved';
const additionalData = (id: string) => new TextEncoder().encode(`cashingularity-wizard:${id}`);

async function access<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open(database, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(storeName);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const request = run(tx.objectStore(storeName));
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () => reject(tx.error ?? new Error('WizardConnect storage was interrupted.'));
    });
  } finally { db.close(); }
}

let queue: Promise<unknown> = Promise.resolve();
function write<T>(operation: () => Promise<T>): Promise<T> {
  const pending = queue.then(operation);
  queue = pending.catch(() => {});
  return pending;
}

async function decryptPairing(saved: EncryptedPairing): Promise<WizardCredentials> {
  const bytes = new Uint8Array(await crypto.subtle.decrypt({
    name: 'AES-GCM',
    iv: saved.iv,
    ...(saved.profile && { additionalData: additionalData(saved.profile.id) }),
  }, saved.key, saved.data));
  try {
    const result = JSON.parse(new TextDecoder().decode(bytes)) as WizardCredentials;
    if (!/^[a-f\d]{64}$/i.test(result.privateKey) || !/^[a-f\d]{64}$/i.test(result.walletPublicKey) ||
        result.walletPublicKey !== saved.peer || typeof result.secret !== 'string' || !result.secret ||
        typeof result.receiveAddress !== 'string' || typeof result.changeAddress !== 'string' ||
        typeof result.walletName !== 'string' || (saved.profile && result.walletName !== saved.profile.name)) {
      throw new Error('Saved WizardConnect pairing is invalid.');
    }
    return result;
  } finally { bytes.fill(0); }
}

async function encryptPairing(id: string, credentials: WizardCredentials): Promise<EncryptedPairing> {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(credentials));
  try {
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: additionalData(id) }, key, plaintext);
    return { profile: { id, name: credentials.walletName }, key, iv, data, peer: credentials.walletPublicKey };
  } finally { plaintext.fill(0); }
}

export function listWizardProfiles(): Promise<SavedWizardProfile[]> {
  return write(async () => {
    const legacy = await access<EncryptedPairing | undefined>('readonly', store => store.get(legacyRecord));
    if (legacy) {
      const credentials = await decryptPairing(legacy).catch(() => undefined);
      if (credentials) {
        const id = crypto.randomUUID();
        const encrypted = await encryptPairing(id, credentials);
        await access('readwrite', store => {
          const current = store.get(legacyRecord);
          current.onsuccess = () => {
            if (!current.result) return;
            store.put(encrypted, id);
            store.delete(legacyRecord);
          };
          return current;
        });
      }
    }
    const entries = await access<EncryptedPairing[]>('readonly', store => store.getAll());
    return entries.flatMap(entry => entry.profile ? [entry.profile] : []);
  });
}

export async function loadWizardCredentials(profileId: string): Promise<WizardCredentials | undefined> {
  await queue;
  const saved = await access<EncryptedPairing | undefined>('readonly', store => store.get(profileId));
  if (!saved) return;
  if (saved.profile?.id !== profileId) throw new Error('Saved WizardConnect identity does not match this profile.');
  return decryptPairing(saved);
}

export function saveWizardCredentials(profileId: string, credentials: WizardCredentials, replace = false): Promise<void> {
  return write(async () => {
    const encrypted = await encryptPairing(profileId, credentials);
    if (!replace) {
      await access('readwrite', store => store.add(encrypted, profileId));
      return;
    }
    await access('readwrite', store => {
      const lookup: IDBRequest<EncryptedPairing | undefined> = store.get(profileId);
      lookup.onsuccess = () => {
        const existing = lookup.result;
        // Check inside the write transaction so a different tab can't revoke between the check and the write.
        if (existing?.profile?.id !== profileId || existing.peer !== encrypted.peer) store.transaction.abort();
        else store.put(encrypted, profileId);
      };
      return lookup;
    });
  });
}

export function forgetWizardCredentials(profileId: string): Promise<void> {
  return write(async () => {
    await access('readwrite', store => store.delete(profileId));
  });
}

export function clearWizardCredentials(): Promise<void> {
  return write(async () => {
    await access('readwrite', store => store.clear());
  });
}
