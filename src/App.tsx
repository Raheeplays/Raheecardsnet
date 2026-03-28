/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { db, auth, getAllDatabases } from './firebase';
import { shardManager, ShardEntity } from './services/shardManager';
import { 
  doc,
  getDoc,
  getDocs,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  collection,
  query,
  where,
  onSnapshot,
  serverTimestamp,
  runTransaction,
  Firestore
} from 'firebase/firestore';
import { signInAnonymously, onAuthStateChanged } from 'firebase/auth';
import firebaseConfig from '../firebase-applet-config.json';
import { handleDatabaseError, OperationType } from './utils/firebaseErrors';
import { UserProfile, GameRoom, Player, CardData } from './types';
import { CARDS } from './constants';
import { 
  Trophy, 
  User, 
  Key, 
  Play, 
  Users, 
  Monitor, 
  MessageSquare, 
  Star, 
  ArrowLeft,
  LogOut,
  LogOut as LogOutIcon,
  Loader2,
  ShieldAlert,
  X,
  RefreshCw
} from 'lucide-react';

// Components
import GameScreen from './components/GameScreen';
import AuthScreen from './components/AuthScreen';
import MainMenu from './components/MainMenu';
import FeedbackScreen from './components/FeedbackScreen';
import SplashScreen from './components/SplashScreen';
import CardManager from './components/CardManager';
import DatabaseManager from './components/DatabaseManager';
import TestingManager from './components/TestingManager';

export default function App() {
  const [view, setView] = useState<'splash' | 'auth' | 'menu' | 'game' | 'feedback' | 'admin' | 'db_manager' | 'testing'>('splash');
  const [user, setUser] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [room, setRoom] = useState<GameRoom | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isOffline, setIsOffline] = useState(false);
  const [isQuotaExceeded, setIsQuotaExceeded] = useState(false);
  const [cards, setCards] = useState<CardData[]>([]);
  const [activeRoom, setActiveRoom] = useState<GameRoom | null>(null);

  const [isAuthReady, setIsAuthReady] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const isAdmin = user?.role === 'admin' || user?.name?.toLowerCase() === 'rahee';

  useEffect(() => {
    // Ensure user is authenticated anonymously for database access
    const unsubscribeAuth = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        setIsAuthReady(true);
        setAuthError(null);
        // Once auth is ready, check for existing session
        await checkSession();
      } else {
        setIsAuthReady(false);
        signInAnonymously(auth).catch(err => {
          console.error("Anonymous auth failed:", err);
          if (err.code === 'auth/admin-restricted-operation') {
            setAuthError('Anonymous Authentication is disabled in Firebase Console. Please enable it in Authentication > Sign-in method.');
          }
        });
      }
    });

    return () => unsubscribeAuth();
  }, []);

  const checkSession = async () => {
    const savedProfile = localStorage.getItem('rahee_profile');
    if (!savedProfile) return;

    setLoading(true);
    try {
      let parsed: any = null;
      try {
        parsed = JSON.parse(savedProfile);
        const uid = parsed.uid || parsed.raheeKey;
        
        // Use shardManager for session check with a longer timeout
        const userSnap = await Promise.race([
          shardManager.getDocWithFailover(ShardEntity.USERS, uid),
          new Promise<null>((_, reject) => setTimeout(() => reject(new Error('Session Check Timeout')), 8000))
        ]) as any;

        if (userSnap && userSnap.exists()) {
          const userData = userSnap.data() as UserProfile;
          if (userData.isApproved === false && userData.name.toLowerCase() !== 'rahee') {
            setError('Waiting For Approval By Rahee');
            localStorage.removeItem('rahee_profile');
            setView('auth');
          } else {
            const profileWithUid = { ...userData, uid: userSnap.id };
            setUser(profileWithUid);
            setView('menu');
          }
        } else {
          localStorage.removeItem('rahee_profile');
          setView('auth');
        }
      } catch (err: any) {
        console.error("Session check error:", err);
        if (err.message === 'Session Check Timeout') {
          setError('Connection Timeout. Please check your internet and refresh.');
        } else {
          localStorage.removeItem('rahee_profile');
          setView('auth');
        }
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Initial splash delay
    const timer = setTimeout(() => {
      if (view === 'splash') setView('auth');
    }, 1000);

    return () => {
      clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (!isAuthReady) return;

    // Fetch cards from Firestore
    const cardsRef = collection(db, 'cards');
    const unsubscribeCards = onSnapshot(cardsRef, async (snap) => {
      const fetchedCards: CardData[] = snap.docs.map(doc => ({ ...doc.data(), id: doc.id } as CardData));
      
      // If some cards are missing, only an admin should add them
      if (fetchedCards.length < CARDS.length && isAdmin) {
        const existingIds = new Set(fetchedCards.map(c => c.id));
        for (const card of CARDS) {
          if (!existingIds.has(card.id)) {
            try {
              await setDoc(doc(db, 'cards', card.id), card);
            } catch (err: any) {
              console.error("Error setting card:", err);
              handleDatabaseError(err, OperationType.WRITE, `cards/${card.id}`);
            }
          }
        }
      } else {
        setCards(fetchedCards.sort((a, b) => Number(a.id) - Number(b.id)));
      }
    }, (err: any) => {
      console.error("Cards listener error:", err);
      
      // Fallback to local cards if error
      if (cards.length === 0) {
        setCards([...CARDS].sort((a, b) => Number(a.id) - Number(b.id)));
      }
      
      handleDatabaseError(err, OperationType.LIST, 'cards');
    });

    // Note: Firestore handles offline state differently, .info/connected is RTDB specific
    // We'll skip it for now as Firestore has built-in offline support

    return () => {
      unsubscribeCards();
    };
  }, [isAuthReady, isAdmin]);

  useEffect(() => {
    if (!isAuthReady) return;
    
    // Bootstrap check: Ensure default admin exists on all shards
    // We only attempt this on databases that are actually available
    const databases = getAllDatabases();
    databases.forEach(database => {
      const adminRef = doc(database, 'users', '786');
      
      // Use a timeout for the bootstrap check to avoid hanging
      const checkPromise = getDoc(adminRef);
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 3000));

      Promise.race([checkPromise, timeoutPromise]).then((snap: any) => {
        if (snap && !snap.exists()) {
          console.log(`Admin user not found in ${database.app.name === '[DEFAULT]' ? 'Primary' : 'Secondary'}. Bootstrapping Rahee...`);
          setDoc(doc(database, 'users', '786'), {
            name: 'Rahee',
            raheeKey: '786',
            role: 'admin',
            isApproved: true,
            authUid: auth.currentUser?.uid,
            createdAt: serverTimestamp()
          }).catch(err => console.error("Bootstrap error:", err));
        }
      }).catch(err => {
        // Only log if it's the primary, otherwise it's expected if secondary is offline
        if (database === db) {
          console.error("Check admin error (Primary):", err);
        } else {
          console.info(`Check admin info (Secondary): Database might be offline or not created.`);
        }
      });
    });
  }, [isAuthReady]);

  useEffect(() => {
    if (!user || !isAuthReady) {
      setActiveRoom(null);
      return;
    }

    const myUid = user.uid || user.raheeKey;
    const roomsRef = shardManager.getCollectionOnShard(ShardEntity.ROOMS, myUid);
    const q = query(roomsRef, where('status', 'in', ['waiting', 'playing']));
    
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const roomsData = snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id } as GameRoom));
      
      const myRooms = roomsData.filter(r => 
        r.players && r.players.some(p => p.uid === myUid)
      );
      
      if (myRooms.length > 0) {
        // Sort by most recent
        myRooms.sort((a, b) => {
          const aTime = (a.createdAt as any)?.toMillis?.() || (a.createdAt as number) || 0;
          const bTime = (b.createdAt as any)?.toMillis?.() || (b.createdAt as number) || 0;
          return bTime - aTime;
        });
        setActiveRoom(myRooms[0]);
      } else {
        setActiveRoom(null);
      }
    }, (err: any) => {
      console.error("Active room listener error:", err);
      handleDatabaseError(err, OperationType.LIST, 'rooms');
    });

    return () => unsubscribe();
  }, [user, isAuthReady]);

  const handleLogin = async (name: string, key: string) => {
    setError(null);
    setLoading(true);
    console.log(`Attempting login for ${name} with key ${key}...`);
    try {
      // Use ShardManager to find the user doc
      const userSnap = await shardManager.getDocWithFailover(ShardEntity.USERS, key);
      
      if (userSnap && userSnap.exists()) {
        const userData = userSnap.data() as UserProfile;
        console.log("User found:", userData);
        
        if (userData.name === name) {
          if (userData.isApproved === false && userData.name.toLowerCase() !== 'rahee') {
            console.warn("User not approved");
            setError('Waiting For Approval By Rahee');
            setLoading(false);
            return;
          }
          
          const profileWithUid = { ...userData, uid: userSnap.id };
          setUser(profileWithUid);
          localStorage.setItem('rahee_profile', JSON.stringify(profileWithUid));
          
          // Logs go to secondary DB if available for efficiency
          const logsDb = shardManager.getDb(ShardEntity.LOGS);
          const authLogsRef = collection(logsDb, 'auth_logs');
          addDoc(authLogsRef, {
            type: 'login',
            status: 'success',
            name,
            raheeKey: key,
            uid: userSnap.id,
            userAgent: navigator.userAgent,
            platform: navigator.platform,
            timestamp: serverTimestamp()
          }).catch(err => console.error("Failed to log auth:", err));
          
          console.log("Login successful, redirecting to menu...");
          setView('menu');
          setLoading(false);
          
          // Update last login and authUid in background on the correct shard
          shardManager.updateDocOnShard(ShardEntity.USERS, key, { 
            lastLogin: serverTimestamp(),
            authUid: auth.currentUser?.uid 
          }).catch(err => console.error("Failed to update last login/authUid:", err));
        } else {
          console.warn("Name mismatch:", userData.name, "vs", name);
          setError('Wrong Name for this Key');
        }
      } else {
        // Auto-register Rahee if using the correct admin key
        const adminKeys = ['786', 'aiza', '181855', 'rahee', 'admin'];
        if (name.toLowerCase() === 'rahee' && adminKeys.includes(key.toLowerCase())) {
          console.log("Admin key detected but not registered. Auto-registering...");
          const adminProfile: UserProfile = {
            name: 'Rahee',
            raheeKey: key,
            wins: 0,
            losses: 0,
            role: 'admin',
            uid: '786',
            isApproved: true
          };
          // Register on primary shard
          await shardManager.setDocOnShard(ShardEntity.USERS, '786', {
            ...adminProfile,
            authUid: auth.currentUser?.uid,
            createdAt: serverTimestamp()
          });
          setUser(adminProfile);
          localStorage.setItem('rahee_profile', JSON.stringify(adminProfile));
          setView('menu');
          return;
        }
        console.warn("User not found with key:", key);
        setError('Unregistered Key.');
      }
    } catch (err: any) {
      console.error("Login error details:", err);
      setError('Connection Error: ' + (err.message || 'Unknown error'));
      handleDatabaseError(err, OperationType.GET, `users/${key}`);
    } finally {
      setLoading(false);
    }
  };

  const handleSignup = async (name: string, key: string) => {
    setError(null);
    setLoading(true);
    console.log(`Attempting signup for ${name} with key ${key}...`);
    
    try {
      // Prevent impersonation of Rahee
      const adminKeys = ['786', 'aiza', '181855', 'rahee', 'admin'];
      if (name.toLowerCase() === 'rahee' && !adminKeys.includes(key.toLowerCase())) {
        setError('Name "Rahee" is reserved for Admin');
        setLoading(false);
        return;
      }

      // Check if key is already taken with timeout
      const userDocRef = doc(db, 'users', key);
      const userSnap = await Promise.race([
        getDoc(userDocRef),
        new Promise<null>((_, reject) => setTimeout(() => reject(new Error('Signup Check Timeout')), 1000))
      ]) as any;
      
      if (userSnap.exists()) {
        console.warn("Key already taken:", key);
        setError('Key already taken');
        setLoading(false);
        return;
      }

      const isRahee = name.toLowerCase() === 'rahee';
      const newProfile: UserProfile = {
        name,
        raheeKey: key,
        wins: 0,
        losses: 0,
        role: isRahee ? 'admin' : 'user',
        uid: key,
        isApproved: isRahee // Admin is auto-approved
      };

      // Add a timeout to the user creation
      await Promise.race([
        setDoc(userDocRef, {
          ...newProfile,
          authUid: auth.currentUser?.uid,
          createdAt: serverTimestamp()
        }),
        new Promise<null>((_, reject) => setTimeout(() => reject(new Error('Signup Timeout')), 1000))
      ]);

      console.log("User created:", newProfile);

      if (!isRahee) {
        console.log("Signup successful, waiting for approval...");
        setError('Waiting For Approval By Rahee');
        setLoading(false);
        return;
      }

      setUser(newProfile);
      localStorage.setItem('rahee_profile', JSON.stringify(newProfile));
      
      const authLogsRef = collection(db, 'auth_logs');
      addDoc(authLogsRef, {
        type: 'signup',
        status: 'success',
        name,
        raheeKey: key,
        uid: key,
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        timestamp: serverTimestamp()
      }).catch(err => console.error("Failed to log auth:", err));
      
      console.log("Signup successful, redirecting to menu...");
      setView('menu');
      setLoading(false);
    } catch (err: any) {
      console.error("Signup error details:", err);
      setError('Signup Failed: ' + (err.message || 'Unknown error'));
      handleDatabaseError(err, OperationType.WRITE, `users/${key}`);
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = () => {
    setUser(null);
    localStorage.removeItem('rahee_profile');
    setView('auth');
  };

  const generateRoomKey = () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let key = '';
    for (let i = 0; i < 6; i++) {
      key += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return key;
  };

  const logGameEvent = async (roomId: string, mode: 'solo' | '1v1' | 'multi', status: 'started' | 'finished') => {
    if (!user) return;
    try {
      await addDoc(collection(db, 'game_logs'), {
        uid: user.uid || user.raheeKey,
        userName: user.name,
        mode,
        timestamp: serverTimestamp(),
        roomId,
        status
      });
    } catch (err) {
      console.error("Failed to log game event:", err);
    }
  };

  const createRoom = async () => {
    if (!user || cards.length === 0) return;
    setLoading(true);
    const roomKey = generateRoomKey();
    const myUid = user.uid || user.raheeKey;
    
    const newRoomData = {
      roomKey,
      hostUid: myUid,
      status: 'waiting',
      mode: 'multi' as const,
      players: [{
        uid: myUid,
        name: user.name,
        deck: [], // Cards dealt on start
        ready: true
      }],
      currentTurn: '',
      createdAt: serverTimestamp()
    };

    try {
      const roomsRef = collection(db, 'rooms');
      const docRef = await addDoc(roomsRef, newRoomData);
      setRoom({ ...newRoomData, id: docRef.id } as any);
      logGameEvent(docRef.id, 'multi', 'started');
      setView('game');
    } catch (err: any) {
      console.error(err);
      setError('Failed to create room');
      handleDatabaseError(err, OperationType.WRITE, 'rooms');
    } finally {
      setLoading(false);
    }
  };

  const joinRoomWithKey = async (key: string) => {
    if (!user || !key) return;
    setLoading(true);
    setError(null);

    try {
      const roomsRef = collection(db, 'rooms');
      const q = query(roomsRef, where('roomKey', '==', key.toUpperCase()), where('status', '==', 'waiting'));
      const snap = await getDocs(q);

      if (snap.empty) {
        setError('Invalid or expired room key');
        return;
      }

      const roomDoc = snap.docs[0];
      const roomData = roomDoc.data() as GameRoom;
      const roomId = roomDoc.id;

      const myUid = user.uid || user.raheeKey;
      const isAlreadyIn = roomData.players && roomData.players.some(p => p.uid === myUid);
      if (isAlreadyIn) {
        setRoom({ ...roomData, id: roomId });
        setView('game');
        return;
      }

      if (roomData.players && roomData.players.length >= 32) {
        setError('This room is already full (Max 32 Players)');
        return;
      }

      const newPlayer = {
        uid: myUid,
        name: user.name,
        deck: [],
        ready: true
      };

      const updatedPlayers = roomData.players ? [...roomData.players, newPlayer] : [newPlayer];
      await updateDoc(doc(db, 'rooms', roomId), {
        players: updatedPlayers
      });

      setRoom({ ...roomData, players: updatedPlayers, id: roomId });
      logGameEvent(roomId, roomData.mode, 'started');
      setView('game');
    } catch (err: any) {
      console.error(err);
      setError('Failed to join room');
      handleDatabaseError(err, OperationType.WRITE, 'rooms');
    } finally {
      setLoading(false);
    }
  };

  const joinRoom = async (mode: 'solo' | '1v1' | 'multi') => {
    if (!user) return;
    setLoading(true);
    setError(null);

    try {
      const myUid = user.uid || user.raheeKey;

      if (mode === 'solo') {
        const deckSource = cards.length > 0 ? cards : CARDS;
        const allCardIds = [...deckSource].map(c => c.id).sort(() => Math.random() - 0.5);
        const half = Math.ceil(allCardIds.length / 2);
        
        const humanPlayer: Player = {
          uid: myUid,
          name: user.name,
          deck: allCardIds.slice(0, half),
          ready: true
        };
        const aiPlayer: Player = {
          uid: 'ai_bot',
          name: 'AI',
          deck: allCardIds.slice(half),
          ready: true
        };
        const newRoom: GameRoom = {
          id: 'solo_' + Date.now(),
          roomKey: 'SOLO',
          hostUid: myUid,
          status: 'playing',
          mode: 'solo',
          players: [humanPlayer, aiPlayer],
          currentTurn: humanPlayer.uid,
          createdAt: Date.now()
        };
        setRoom(newRoom);
        logGameEvent(newRoom.id, 'solo', 'started');
        setView('game');
        return;
      }

      const roomsRef = collection(db, 'rooms');
      const q = query(roomsRef, where('status', '==', 'waiting'));
      const roomsSnap = await getDocs(q);
      
      const roomsData: GameRoom[] = roomsSnap.docs.map(doc => ({ ...doc.data(), id: doc.id } as GameRoom));
      
      // Check if I'm already in any of these rooms
      const myRoom = roomsData.find(r => r.players && r.players.some(p => p.uid === myUid));
      if (myRoom) {
        setRoom(myRoom);
        setView('game');
        return;
      }

      // Find a room that is not full and matches the mode
      const availableRooms = roomsData.filter(r => 
        r.mode === mode && 
        (!r.players || r.players.length < (mode === '1v1' ? 2 : 32))
      );
      
      if (availableRooms.length > 0) {
        // Try to join the first available room
        const roomToJoin = availableRooms[0];
        
        const newPlayer = {
          uid: myUid,
          name: user.name,
          deck: [],
          ready: true
        };
        
        try {
          const updatedPlayers = roomToJoin.players ? [...roomToJoin.players, newPlayer] : [newPlayer];
          await updateDoc(doc(db, 'rooms', roomToJoin.id), {
            players: updatedPlayers
          });
          
          setRoom({ ...roomToJoin, players: updatedPlayers });
          logGameEvent(roomToJoin.id, mode, 'started');
          setView('game');
          return;
        } catch (err: any) {
          // If update fails (e.g. room became full), try again or create new
          console.error("Join failed, retrying...", err);
          await createNewRoom(myUid, mode);
        }
      } else {
        await createNewRoom(myUid, mode);
      }
    } catch (err: any) {
      console.error("Matchmaking error:", err);
      setError('Matchmaking failed');
    } finally {
      setLoading(false);
    }
  };

  const createNewRoom = async (myUid: string, mode: '1v1' | 'multi') => {
    const roomKey = generateRoomKey();
    const newRoomData = {
      roomKey,
      status: 'waiting',
      mode,
      hostUid: myUid,
      players: [{
        uid: myUid,
        name: user.name,
        deck: [],
        ready: true
      }],
      currentTurn: '',
      createdAt: serverTimestamp()
    };
    
    try {
      const roomsRef = collection(db, 'rooms');
      const docRef = await addDoc(roomsRef, newRoomData);
      
      setRoom({ ...newRoomData, id: docRef.id } as any);
      logGameEvent(docRef.id, mode, 'started');
      setView('game');
    } catch (err: any) {
      console.error("Create room error:", err);
      setError('Failed to create room');
      handleDatabaseError(err, OperationType.WRITE, 'rooms');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white font-sans selection:bg-rahee/30">
      <AnimatePresence mode="wait">
        {view === 'splash' && !authError && (
          <SplashScreen 
            key="splash-screen"
            onComplete={() => setView('auth')} 
          />
        )}
        {view === 'auth' && (
          <AuthScreen 
            key="auth-screen"
            onLogin={handleLogin} 
            onSignup={handleSignup} 
            error={error} 
            loading={loading}
          />
        )}
        {view === 'menu' && user && (
          <MainMenu 
            key="menu-screen"
            user={user} 
            onJoinRoom={joinRoom} 
            onCreateRoom={createRoom}
            onJoinWithKey={joinRoomWithKey}
            onLogout={handleLogout}
            onFeedback={() => setView('feedback')}
            isAdmin={isAdmin}
            onAdminClick={() => setView('admin')}
            onDbManagerClick={() => setView('db_manager')}
            onTestingClick={() => setView('testing')}
            activeRoom={activeRoom}
            isQuotaExceeded={isQuotaExceeded}
            onExitRoom={async () => {
              if (activeRoom) {
                try {
                  const myUid = user.uid || user.raheeKey;
                  await runTransaction(db, async (transaction) => {
                    const roomDocRef = doc(db, 'rooms', activeRoom.id);
                    const roomDoc = await transaction.get(roomDocRef);
                    if (!roomDoc.exists()) return;
                    
                    const currentRoomData = roomDoc.data() as GameRoom;
                    const currentPlayers = currentRoomData.players || [];
                    const updatedPlayers = currentPlayers.filter((p: any) => p.uid !== myUid);
                    
                    if (updatedPlayers.length === 0) {
                      transaction.update(roomDocRef, { status: 'finished' });
                      // Log game finished for the last player
                      logGameEvent(activeRoom.id, activeRoom.mode, 'finished');
                    } else {
                      const updates: any = { players: updatedPlayers };
                      // If the host left, assign a new host
                      if (currentRoomData.hostUid === myUid) {
                        updates.hostUid = updatedPlayers[0].uid;
                      }
                      transaction.update(roomDocRef, updates);
                    }
                  });
                  
                  setActiveRoom(null);
                } catch (err) {
                  console.error("Failed to exit room:", err);
                  handleDatabaseError(err, OperationType.UPDATE, `rooms/${activeRoom.id}`);
                }
              }
            }}
            onResumeRoom={() => {
              if (activeRoom) {
                setRoom(activeRoom);
                setView('game');
              }
            }}
          />
        )}
        {view === 'admin' && user && isAdmin && (
          <CardManager 
            key="admin-screen"
            onBack={() => setView('menu')}
            cards={cards}
          />
        )}
        {view === 'db_manager' && user && isAdmin && (
          <DatabaseManager 
            key="db-manager-screen"
            onBack={() => setView('menu')}
          />
        )}
        {view === 'testing' && user && isAdmin && (
          <TestingManager 
            onBack={() => setView('menu')}
          />
        )}
        {view === 'game' && room && user && (
          <GameScreen 
            key="game-screen"
            room={room} 
            user={user} 
            cards={cards}
            onExit={() => { setRoom(null); setView('menu'); }} 
            isAdmin={isAdmin}
            setIsQuotaExceeded={setIsQuotaExceeded}
          />
        )}
        {view === 'feedback' && user && (
          <FeedbackScreen 
            key="feedback-screen"
            user={user} 
            onBack={() => setView('menu')} 
          />
        )}
      </AnimatePresence>
    </div>
  );
}
