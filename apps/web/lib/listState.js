// The dashboard list as a pure reducer: loading, ready, failed, and the
// merges that keep it current as uploads finish and files are deleted.

export const initialListState = {
  status: 'loading', // 'loading' | 'ready' | 'error'
  items: [],
  nextCursor: null,
  error: null,         // a failed first load: shown instead of the list
  loadingMore: false,
  moreError: null,     // a failed "load more": shown under the list, which stays
};

export function listReducer(state, action) {
  switch (action.type) {
    case 'load':
      return { ...state, status: 'loading', error: null };
    case 'loaded':
      return { ...state, status: 'ready', items: action.items, nextCursor: action.nextCursor, error: null };
    case 'failed':
      return { ...state, status: 'error', error: action.error };

    case 'loadMore':
      return { ...state, loadingMore: true, moreError: null };
    case 'loadedMore': {
      const known = new Set(state.items.map(f => f.id));
      return {
        ...state,
        loadingMore: false,
        items: [...state.items, ...action.items.filter(f => !known.has(f.id))],
        nextCursor: action.nextCursor,
      };
    }
    case 'loadMoreFailed':
      return { ...state, loadingMore: false, moreError: action.error };

    // A fresh first page after an upload finishes: update rows we have,
    // put new ones on top, keep everything already paged in below.
    case 'mergeHead': {
      const fresh = new Map(action.items.map(f => [f.id, f]));
      const kept = state.items.filter(f => !fresh.has(f.id)).map(f => f);
      return { ...state, status: 'ready', error: null, items: [...action.items, ...kept] };
    }
    case 'removed':
      return { ...state, items: state.items.filter(f => f.id !== action.id) };
    default:
      return state;
  }
}

// Unfinished uploads ("resume me") are listed apart from stored files.
export const unfinished = items => items.filter(f => f.status === 'uploading' || f.status === 'completing');
export const stored = items => items.filter(f => f.status === 'complete');
