import React, { Component } from 'react';
import OpenImpute from './OpenImpute';

// --- Environment Polyfills ---
// Ensures the app doesn't crash in environments where window.storage is expected but missing.
if (typeof window !== 'undefined') {
  if (!window.storage) {
    window.storage = {
      async get(key) {
        try {
          const val = window.localStorage.getItem(key);
          return val !== null ? { value: val } : null;
        } catch (e) {
          console.warn('Storage access failed', e);
          return null;
        }
      },
      async set(key, value) {
        try {
          window.localStorage.setItem(key, value);
        } catch (e) {
          console.warn('Storage write failed', e);
        }
      },
      async delete(key) {
        try {
          window.localStorage.removeItem(key);
        } catch (e) {
          console.warn('Storage delete failed', e);
        }
      },
    };
  }
}

// --- Simple Error Boundary ---
class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    // Optional: log error to an external service
    console.error('ErrorBoundary caught an error:', error, errorInfo);
  }

  render() {
    const { hasError, error } = this.state;

    if (hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-slate-900 text-white p-4">
          <div className="bg-red-900/20 border border-red-500 rounded-lg p-6 max-w-md">
            <h2 className="text-xl font-bold mb-2 text-red-400">Application Error</h2>
            <p className="text-sm text-slate-300 mb-4">
              Something went wrong while loading the application.
            </p>
            {error && (
              <pre className="bg-black/50 p-2 rounded text-xs text-red-300 overflow-auto">
                {String(error)}
              </pre>
            )}
            <button
              onClick={() => window.location.reload()}
              className="mt-4 bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded text-sm transition-colors"
            >
              Reload Application
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

function App() {
  return (
    <ErrorBoundary>
      <div className="App min-h-screen bg-slate-900">
        <OpenImpute />
      </div>
    </ErrorBoundary>
  );
}

export default App;
