import { Firestore, collection, doc, getDoc, setDoc, updateDoc, deleteDoc, query, onSnapshot, getDocs, QueryConstraint, DocumentData, WithFieldValue, UpdateData } from 'firebase/firestore';
import { db, secondaryDb, getAllDatabases } from '../firebase';

/**
 * ShardManager handles data distribution across multiple Firebase projects/databases.
 * This helps with:
 * 1. Load balancing (distributing writes/reads)
 * 2. Quota management (avoiding single-project limits)
 * 3. Failover (using a secondary database if the primary is down)
 */

export enum ShardEntity {
  USERS = 'users',
  ROOMS = 'rooms',
  LOGS = 'logs',
  FEEDBACK = 'feedback',
  CARDS = 'cards'
}

class ShardManager {
  private availableDatabases: Firestore[] = [];

  constructor() {
    this.refreshAvailableDatabases();
  }

  /**
   * Refreshes the list of available and reachable databases.
   */
  async refreshAvailableDatabases() {
    const dbs = getAllDatabases();
    const reachable: Firestore[] = [];
    
    // We check in parallel with a timeout
    await Promise.all(dbs.map(async (d) => {
      try {
        // Use a short timeout for the health check
        const testPromise = getDoc(doc(d, 'connection_test', 'connection'));
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 2000));
        
        await Promise.race([testPromise, timeoutPromise]);
        reachable.push(d);
      } catch (e) {
        // If it's the primary, we keep it anyway as it's the main source
        if (d === db) {
          reachable.push(d);
        } else {
          console.info(`ShardManager: Database ${d.app.name} is not reachable or not yet created.`);
        }
      }
    }));
    
    this.availableDatabases = reachable;
  }

  /**
   * Selects the appropriate database for a given entity and shard key.
   */
  getDb(entity: ShardEntity, shardKey?: string): Firestore {
    const databases = this.availableDatabases.length > 0 ? this.availableDatabases : getAllDatabases();
    if (databases.length === 1) return databases[0];

    // Dedicated database for logs/feedback if secondary is available and reachable
    const secondary = databases.find(d => d !== db);
    if ((entity === ShardEntity.LOGS || entity === ShardEntity.FEEDBACK) && secondary) {
      return secondary;
    }

    // Sharding logic for users and rooms
    if (shardKey && (entity === ShardEntity.USERS || entity === ShardEntity.ROOMS)) {
      const hash = this.simpleHash(shardKey);
      return databases[hash % databases.length];
    }

    // Default to primary
    return db;
  }

  /**
   * Simple hash function to distribute keys across databases.
   */
  private simpleHash(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash |= 0; // Convert to 32bit integer
    }
    return Math.abs(hash);
  }

  /**
   * Wrapper for Firestore operations with automatic failover for non-critical reads.
   */
  async getDocWithFailover(entity: ShardEntity, id: string, shardKey?: string) {
    const primary = this.getDb(entity, shardKey || id);
    try {
      return await getDoc(doc(primary, entity, id));
    } catch (error) {
      console.error(`Primary DB error for ${entity}/${id}:`, error);
      // If primary fails and it's a non-critical entity, try another DB
      if (secondaryDb && primary !== secondaryDb) {
        console.log(`Attempting failover to secondary DB for ${entity}/${id}`);
        return await getDoc(doc(secondaryDb, entity, id));
      }
      throw error;
    }
  }

  /**
   * Helper to perform a write operation on the correct shard.
   */
  async setDocOnShard<T extends WithFieldValue<DocumentData>>(entity: ShardEntity, id: string, data: T, shardKey?: string) {
    const targetDb = this.getDb(entity, shardKey || id);
    return await setDoc(doc(targetDb, entity, id), data);
  }

  /**
   * Helper to perform an update operation on the correct shard.
   */
  async updateDocOnShard<T extends DocumentData>(entity: ShardEntity, id: string, data: UpdateData<T>, shardKey?: string) {
    const targetDb = this.getDb(entity, shardKey || id);
    return await updateDoc(doc(targetDb, entity, id), data);
  }

  /**
   * Helper to perform a delete operation on the correct shard.
   */
  async deleteDocOnShard(entity: ShardEntity, id: string, shardKey?: string) {
    const targetDb = this.getDb(entity, shardKey || id);
    return await deleteDoc(doc(targetDb, entity, id));
  }

  /**
   * Helper to perform a query on the correct shard.
   * Note: Cross-shard queries are complex; this assumes the query is scoped to a shard.
   */
  getCollectionOnShard(entity: ShardEntity, shardKey?: string) {
    const targetDb = this.getDb(entity, shardKey);
    return collection(targetDb, entity);
  }
}

export const shardManager = new ShardManager();
