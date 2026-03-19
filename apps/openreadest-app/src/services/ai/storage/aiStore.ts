import type { AIConversation, AIMessage } from '../types';

const DB_NAME = 'openreadest-ai';
const DB_VERSION = 1;
const CONVERSATIONS_STORE = 'conversations';
const MESSAGES_STORE = 'messages';

class AIStore {
  private db: IDBDatabase | null = null;

  private async openDB(): Promise<IDBDatabase> {
    if (this.db) return this.db;
    return await new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve(request.result);
      };
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(CONVERSATIONS_STORE)) {
          const store = db.createObjectStore(CONVERSATIONS_STORE, { keyPath: 'id' });
          store.createIndex('bookHash', 'bookHash', { unique: false });
        }
        if (!db.objectStoreNames.contains(MESSAGES_STORE)) {
          const store = db.createObjectStore(MESSAGES_STORE, { keyPath: 'id' });
          store.createIndex('conversationId', 'conversationId', { unique: false });
        }
      };
    });
  }

  async getConversations(bookHash: string): Promise<AIConversation[]> {
    const db = await this.openDB();
    return await new Promise((resolve, reject) => {
      const request = db
        .transaction(CONVERSATIONS_STORE, 'readonly')
        .objectStore(CONVERSATIONS_STORE)
        .index('bookHash')
        .getAll(bookHash);
      request.onsuccess = () => {
        resolve((request.result as AIConversation[]).sort((a, b) => b.updatedAt - a.updatedAt));
      };
      request.onerror = () => reject(request.error);
    });
  }

  async saveConversation(conversation: AIConversation): Promise<void> {
    const db = await this.openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(CONVERSATIONS_STORE, 'readwrite');
      tx.objectStore(CONVERSATIONS_STORE).put(conversation);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getMessages(conversationId: string): Promise<AIMessage[]> {
    const db = await this.openDB();
    return await new Promise((resolve, reject) => {
      const request = db
        .transaction(MESSAGES_STORE, 'readonly')
        .objectStore(MESSAGES_STORE)
        .index('conversationId')
        .getAll(conversationId);
      request.onsuccess = () => {
        resolve((request.result as AIMessage[]).sort((a, b) => a.createdAt - b.createdAt));
      };
      request.onerror = () => reject(request.error);
    });
  }

  async saveMessage(message: AIMessage): Promise<void> {
    const db = await this.openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(MESSAGES_STORE, 'readwrite');
      tx.objectStore(MESSAGES_STORE).put(message);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async updateMessage(id: string, updates: Partial<Pick<AIMessage, 'content' | 'attachments'>>): Promise<void> {
    const db = await this.openDB();
    const existing = await new Promise<AIMessage | undefined>((resolve, reject) => {
      const request = db.transaction(MESSAGES_STORE, 'readonly').objectStore(MESSAGES_STORE).get(id);
      request.onsuccess = () => resolve(request.result as AIMessage | undefined);
      request.onerror = () => reject(request.error);
    });
    if (!existing) return;
    await this.saveMessage({ ...existing, ...updates });
  }

  async deleteMessage(id: string): Promise<void> {
    const db = await this.openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(MESSAGES_STORE, 'readwrite');
      tx.objectStore(MESSAGES_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async updateConversationTitle(id: string, title: string): Promise<void> {
    const db = await this.openDB();
    const conversation = await new Promise<AIConversation | undefined>((resolve, reject) => {
      const request = db
        .transaction(CONVERSATIONS_STORE, 'readonly')
        .objectStore(CONVERSATIONS_STORE)
        .get(id);
      request.onsuccess = () => resolve(request.result as AIConversation | undefined);
      request.onerror = () => reject(request.error);
    });
    if (!conversation) return;
    await this.saveConversation({ ...conversation, title, updatedAt: Date.now() });
  }

  async deleteConversation(id: string): Promise<void> {
    const db = await this.openDB();
    const messages = await this.getMessages(id);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([CONVERSATIONS_STORE, MESSAGES_STORE], 'readwrite');
      tx.objectStore(CONVERSATIONS_STORE).delete(id);
      const messageStore = tx.objectStore(MESSAGES_STORE);
      messages.forEach((message) => messageStore.delete(message.id));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}

export const aiStore = new AIStore();
