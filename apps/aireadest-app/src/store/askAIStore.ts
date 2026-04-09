import { create } from 'zustand';

interface AskAIState {
  openBookKey: string | null;
  openForBook: (bookKey: string) => void;
  closeForBook: (bookKey: string) => void;
  toggleForBook: (bookKey: string) => void;
}

export const useAskAIStore = create<AskAIState>((set, get) => ({
  openBookKey: null,
  openForBook: (bookKey) => set({ openBookKey: bookKey }),
  closeForBook: (bookKey) => {
    if (get().openBookKey === bookKey) {
      set({ openBookKey: null });
    }
  },
  toggleForBook: (bookKey) =>
    set((state) => ({ openBookKey: state.openBookKey === bookKey ? null : bookKey })),
}));
