import { initializeApp, getApps, getApp, FirebaseApp } from 'firebase/app';
import { getFirestore, doc, getDoc, setDoc, collection, query, where, getDocs, onSnapshot, updateDoc, deleteDoc, serverTimestamp, Firestore } from 'firebase/firestore';
import { getAuth, Auth } from 'firebase/auth';

// Import the Firebase configurations
import primaryConfig from '../firebase-applet-config.json';
import secondaryConfigJson from '../firebase-secondary-config.json';

// Auto-merge environment variables for secondary config
const secondaryConfig = {
  apiKey: (import.meta as any).env?.VITE_SECONDARY_FIREBASE_API_KEY || secondaryConfigJson.apiKey,
  authDomain: (import.meta as any).env?.VITE_SECONDARY_FIREBASE_AUTH_DOMAIN || secondaryConfigJson.authDomain,
  projectId: (import.meta as any).env?.VITE_SECONDARY_FIREBASE_PROJECT_ID || secondaryConfigJson.projectId,
  storageBucket: (import.meta as any).env?.VITE_SECONDARY_FIREBASE_STORAGE_BUCKET || secondaryConfigJson.storageBucket,
  messagingSenderId: (import.meta as any).env?.VITE_SECONDARY_FIREBASE_MESSAGING_SENDER_ID || secondaryConfigJson.messagingSenderId,
  appId: (import.meta as any).env?.VITE_SECONDARY_FIREBASE_APP_ID || secondaryConfigJson.appId,
  firestoreDatabaseId: (import.meta as any).env?.VITE_SECONDARY_FIREBASE_DATABASE_ID || secondaryConfigJson.firestoreDatabaseId,
};

// Function to initialize an app safely
const initApp = (config: any, name: string): FirebaseApp | null => {
  try {
    if (config.projectId && !config.projectId.includes('TODO') && !config.projectId.includes('SECONDARY')) {
      const apps = getApps();
      const existingApp = apps.find(a => a.name === name);
      if (existingApp) return existingApp;
      return initializeApp(config, name);
    }
  } catch (error) {
    console.warn(`Failed to initialize Firebase app: ${name}`, error);
  }
  return null;
};

// Initialize Primary App (Default)
const primaryApp = initializeApp(primaryConfig);
export const db = getFirestore(primaryApp, primaryConfig.firestoreDatabaseId);
export const auth = getAuth(primaryApp);

// Initialize Secondary App (Optional)
const secondaryApp = initApp(secondaryConfig, 'secondary');
export const secondaryDb = secondaryApp ? getFirestore(secondaryApp, secondaryConfig.firestoreDatabaseId) : null;

// Helper to get all available databases
export const getAllDatabases = (): Firestore[] => {
  const dbs = [db];
  if (secondaryDb) dbs.push(secondaryDb);
  return dbs;
};

// Connection test for all databases
export async function testConnections() {
  const databases = getAllDatabases();
  const results = await Promise.allSettled(databases.map(async (database, index) => {
    try {
      // Use a very short timeout for the connection test
      const testPromise = getDoc(doc(database, 'connection_test', 'connection'));
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 2000));
      
      await Promise.race([testPromise, timeoutPromise]);
      console.log(`Firestore ${index === 0 ? 'Primary' : 'Secondary'} connection successful.`);
      return true;
    } catch (error: any) {
      if (index === 0) {
        console.warn(`Primary database connection check failed: ${error.message}`);
      } else {
        console.info(`Secondary database not reachable or not yet created. This is normal if only one database is used.`);
      }
      return false;
    }
  }));
  return results;
}

// Don't block module load with connection tests
setTimeout(testConnections, 1000);
