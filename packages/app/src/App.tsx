import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { lazy, Suspense } from 'react';
import { SessionProvider } from './context/SessionContext.tsx';

// Lazy-load each page so only the active route's CSS is fetched per tab.
// The legacy app loaded one stylesheet per page; code-splitting preserves that
// isolation and avoids cross-page `body`/`:root`/class collisions in the SPA.
const IndexPage      = lazy(() => import('./pages/IndexPage/IndexPage.tsx'));
const ControllerPage = lazy(() => import('./pages/ControllerPage/ControllerPage.tsx'));
const PlayerPage     = lazy(() => import('./pages/PlayerPage/PlayerPage.tsx'));
const RequestPage    = lazy(() => import('./pages/RequestPage/RequestPage.tsx'));
const DisplayPage    = lazy(() => import('./pages/DisplayPage/DisplayPage.tsx'));

export default function App() {
  return (
    <SessionProvider>
      <BrowserRouter>
        <Suspense fallback={null}>
          <Routes>
            <Route path="/" element={<IndexPage />} />
            <Route path="/controller" element={<ControllerPage />} />
            <Route path="/player" element={<PlayerPage />} />
            <Route path="/request" element={<RequestPage />} />
            <Route path="/display" element={<DisplayPage />} />
          </Routes>
        </Suspense>
      </BrowserRouter>
    </SessionProvider>
  );
}
