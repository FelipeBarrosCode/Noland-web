import type { PersistedAppState } from "../lib/types";
import { createDefaultWebState } from "./defaultState";

const DATABASE_NAME = "noland-web";
const STORE_NAME = "application";
const STATE_KEY = "state";
const VAST_SESSION_KEY = "noland-web:vast-api-key";

let stateWrite = Promise.resolve();

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Unable to open browser state database"));
  });
}

async function readValue<T>(key: string): Promise<T | undefined> {
  const database = await openDatabase();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(key);
      request.onsuccess = () => resolve(request.result as T | undefined);
      request.onerror = () => reject(request.error ?? new Error(`Unable to read ${key}`));
    });
  } finally {
    database.close();
  }
}

async function writeValue<T>(key: string, value: T): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put(value, key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error(`Unable to write ${key}`));
      transaction.onabort = () => reject(transaction.error ?? new Error(`Writing ${key} was aborted`));
    });
  } finally {
    database.close();
  }
}

function mergeState(saved: Partial<PersistedAppState> | undefined): PersistedAppState {
  const defaults = createDefaultWebState();
  if (!saved) return defaults;
  return {
    ...defaults,
    ...saved,
    credentials: { ...defaults.credentials, ...saved.credentials },
    ssh: { ...defaults.ssh, ...saved.ssh },
    location: { ...defaults.location, ...saved.location },
    serverPreferences: { ...defaults.serverPreferences, ...saved.serverPreferences },
    instance: { ...defaults.instance, ...saved.instance },
    wireguard: { ...defaults.wireguard, ...saved.wireguard },
    sunshine: { ...defaults.sunshine, ...saved.sunshine },
    moonlight: { ...defaults.moonlight, ...saved.moonlight },
    moonlightPreferences: { ...defaults.moonlightPreferences, ...saved.moonlightPreferences },
    autoShutdown: {
      ...defaults.autoShutdown,
      ...saved.autoShutdown,
      settings: { ...defaults.autoShutdown.settings, ...saved.autoShutdown?.settings },
    },
    cloudflareTurn: { ...defaults.cloudflareTurn, ...saved.cloudflareTurn },
    postWireguardSetup: { ...defaults.postWireguardSetup, ...saved.postWireguardSetup },
  };
}

export async function loadWebState(): Promise<PersistedAppState> {
  const state = mergeState(await readValue<Partial<PersistedAppState>>(STATE_KEY));
  state.credentials.vastApiKey = sessionStorage.getItem(VAST_SESSION_KEY) ?? "";
  if (state.onboardingCompleted && !state.credentials.vastApiKey) {
    state.onboardingCompleted = false;
  }
  return state;
}

export async function saveWebState(state: PersistedAppState): Promise<PersistedAppState> {
  const snapshot = structuredClone(state);
  if (snapshot.credentials.vastApiKey) {
    sessionStorage.setItem(VAST_SESSION_KEY, snapshot.credentials.vastApiKey);
  } else {
    sessionStorage.removeItem(VAST_SESSION_KEY);
  }
  const persisted = structuredClone(snapshot);
  persisted.credentials.vastApiKey = "";
  persisted.credentials.appPassword = "";
  persisted.credentials.twitchClientSecret = "";
  stateWrite = stateWrite.then(() => writeValue(STATE_KEY, persisted));
  await stateWrite;
  return snapshot;
}

export async function updateWebState(
  update: (state: PersistedAppState) => void,
): Promise<PersistedAppState> {
  const state = await loadWebState();
  update(state);
  return saveWebState(state);
}
