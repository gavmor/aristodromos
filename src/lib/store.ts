import type { StateStorage } from 'zustand/middleware'

import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

// Define the interface for your store
interface ExtensionState {
  scrapedData: null | string
  setScrapedData: (data: string) => void
}

// Adapter to wrap chrome.storage.local for Zustand
const storageAdapter: StateStorage = {
  getItem: async (name: string): Promise<any> => {
    const result = await chrome.storage.local.get(name)
    return result[name]
  },
  removeItem: async (name: string): Promise<void> => {
    await chrome.storage.local.remove(name)
  },
  setItem: async (name: string, value: string): Promise<void> => {
    await chrome.storage.local.set({ [name]: value })
  },
}

export const useStore = create<ExtensionState>()(
  persist(
    set => ({
      scrapedData: null,
      setScrapedData: data => set({ scrapedData: data }),
    }),
    {
      name: 'wxt-shared-storage', // Unique key in storage
      storage: createJSONStorage(() => storageAdapter),
    },
  ),
)

// SYNC LOGIC: This ensures all extension parts stay in sync
if (typeof chrome !== 'undefined' && chrome.storage) {
  chrome.storage.onChanged.addListener((changes) => {
    if (changes['wxt-shared-storage']) {
      useStore.persist.rehydrate()
    }
  })
}
