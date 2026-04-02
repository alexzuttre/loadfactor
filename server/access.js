import { Firestore, FieldValue } from '@google-cloud/firestore';

const USER_ACCESS_COLLECTION = 'user_access';
const firestoreCache = new Map();

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function getFirestore(config) {
  const key = config.googleCloudProject || '__default__';
  if (!firestoreCache.has(key)) {
    firestoreCache.set(key, new Firestore(
      config.googleCloudProject ? { projectId: config.googleCloudProject } : undefined,
    ));
  }
  return firestoreCache.get(key);
}

function getCollection(config) {
  return getFirestore(config).collection(USER_ACCESS_COLLECTION);
}

export function isAccessAuthorized(access) {
  return Boolean(access && access.status === 'active');
}

export function buildAccessDeniedMessage(access, email) {
  if (access?.status === 'disabled') {
    return `${email} is authenticated, but access is currently disabled. Contact alex.zuttre@flyr.com if you believe this is a mistake.`;
  }
  return `${email} is authenticated, but is not on the LoadFactor allowlist. Contact alex.zuttre@flyr.com to request access.`;
}

export async function getAccessRecord(config, email) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return null;

  const snapshot = await getCollection(config).doc(normalizedEmail).get();
  if (!snapshot.exists) return null;

  const data = snapshot.data() || {};
  return {
    email: normalizedEmail,
    role: data.role || 'viewer',
    status: data.status || 'active',
    createdAt: data.createdAt ?? null,
    updatedAt: data.updatedAt ?? null,
    updatedBy: data.updatedBy ?? null,
  };
}

export async function ensureBootstrapAdmin(config, email) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail || !config.bootstrapAdminEmails.includes(normalizedEmail)) return null;

  const docRef = getCollection(config).doc(normalizedEmail);
  await getFirestore(config).runTransaction(async (tx) => {
    const snapshot = await tx.get(docRef);
    if (snapshot.exists) return;

    tx.set(docRef, {
      email: normalizedEmail,
      role: 'admin',
      status: 'active',
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: 'bootstrap',
    });
  });

  return getAccessRecord(config, normalizedEmail);
}

export async function resolveAccessRecord(config, email) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return null;
  await ensureBootstrapAdmin(config, normalizedEmail);
  return getAccessRecord(config, normalizedEmail);
}

export async function upsertAccessRecord(config, { email, role = 'viewer', status = 'active', updatedBy = 'seed-script' }) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) throw new Error('Email is required.');
  if (!['viewer', 'admin'].includes(role)) throw new Error(`Unsupported role: ${role}`);
  if (!['active', 'disabled'].includes(status)) throw new Error(`Unsupported status: ${status}`);

  const docRef = getCollection(config).doc(normalizedEmail);
  await getFirestore(config).runTransaction(async (tx) => {
    const snapshot = await tx.get(docRef);
    const existing = snapshot.exists ? snapshot.data() : null;
    tx.set(docRef, {
      email: normalizedEmail,
      role,
      status,
      createdAt: existing?.createdAt || FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy,
    });
  });

  return getAccessRecord(config, normalizedEmail);
}
