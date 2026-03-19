import { create } from 'zustand';
import type { AIConversation, AIMessage } from '@/services/ai/types';
import { aiStore } from '@/services/ai/storage/aiStore';

interface AIChatState {
  activeConversationId: string | null;
  conversations: AIConversation[];
  messages: AIMessage[];
  isLoadingHistory: boolean;
  currentBookHash: string | null;
  loadConversations: (bookHash: string) => Promise<void>;
  setActiveConversation: (id: string | null) => Promise<void>;
  createConversation: (bookHash: string, title: string) => Promise<string>;
  addMessage: (message: Omit<AIMessage, 'id' | 'createdAt'>) => Promise<AIMessage>;
  deleteConversation: (id: string) => Promise<void>;
  renameConversation: (id: string, title: string) => Promise<void>;
  clearActiveConversation: () => void;
}

const generateId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

export const useAIChatStore = create<AIChatState>((set, get) => ({
  activeConversationId: null,
  conversations: [],
  messages: [],
  isLoadingHistory: false,
  currentBookHash: null,

  loadConversations: async (bookHash) => {
    set({ isLoadingHistory: true });
    try {
      const conversations = await aiStore.getConversations(bookHash);
      set({ conversations, currentBookHash: bookHash, isLoadingHistory: false });
    } catch {
      set({ conversations: [], currentBookHash: bookHash, isLoadingHistory: false });
    }
  },

  setActiveConversation: async (id) => {
    if (!id) {
      set({ activeConversationId: null, messages: [] });
      return;
    }
    set({ isLoadingHistory: true });
    try {
      const messages = await aiStore.getMessages(id);
      set({ activeConversationId: id, messages, isLoadingHistory: false });
    } catch {
      set({ activeConversationId: id, messages: [], isLoadingHistory: false });
    }
  },

  createConversation: async (bookHash, title) => {
    const now = Date.now();
    const conversation: AIConversation = {
      id: generateId(),
      bookHash,
      title: title.trim().slice(0, 50) || 'Ask AI',
      createdAt: now,
      updatedAt: now,
    };
    await aiStore.saveConversation(conversation);
    const conversations = await aiStore.getConversations(bookHash);
    set({ currentBookHash: bookHash, conversations, activeConversationId: conversation.id, messages: [] });
    return conversation.id;
  },

  addMessage: async (message) => {
    const fullMessage: AIMessage = { ...message, id: generateId(), createdAt: Date.now() };
    await aiStore.saveMessage(fullMessage);
    const { activeConversationId, currentBookHash, conversations } = get();
    if (activeConversationId && currentBookHash) {
      const conversation = conversations.find((item) => item.id === activeConversationId);
      if (conversation) {
        await aiStore.saveConversation({ ...conversation, updatedAt: Date.now() });
      }
      const nextConversations = await aiStore.getConversations(currentBookHash);
      set((state) => ({ conversations: nextConversations, messages: [...state.messages, fullMessage] }));
    } else {
      set((state) => ({ messages: [...state.messages, fullMessage] }));
    }
    return fullMessage;
  },

  deleteConversation: async (id) => {
    const { currentBookHash, activeConversationId } = get();
    await aiStore.deleteConversation(id);
    const conversations = currentBookHash ? await aiStore.getConversations(currentBookHash) : [];
    set({ conversations, ...(activeConversationId === id ? { activeConversationId: null, messages: [] } : {}) });
  },

  renameConversation: async (id, title) => {
    const { currentBookHash } = get();
    await aiStore.updateConversationTitle(id, title);
    if (!currentBookHash) return;
    const conversations = await aiStore.getConversations(currentBookHash);
    set({ conversations });
  },

  clearActiveConversation: () => set({ activeConversationId: null, messages: [] }),
}));
