import { Routes, Route } from 'react-router-dom'
import { AuthProvider } from './lib/auth'
import RequireAuth from './components/RequireAuth'
import Layout from './components/Layout'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import NewJob from './pages/NewJob'
import JobDetail from './pages/JobDetail'
import LocalConvert from './pages/LocalConvert'

export default function App() {
  return (
    <AuthProvider>
      <Layout>
        <Routes>
          <Route path="/login" element={<Login />} />
          {/* Conversion runs entirely in the browser, but the app itself is
              behind sign-in. */}
          <Route
            path="/"
            element={
              <RequireAuth>
                <LocalConvert />
              </RequireAuth>
            }
          />
          <Route
            path="/dashboard"
            element={
              <RequireAuth>
                <Dashboard />
              </RequireAuth>
            }
          />
          <Route
            path="/jobs/new"
            element={
              <RequireAuth>
                <NewJob />
              </RequireAuth>
            }
          />
          <Route
            path="/jobs/:id"
            element={
              <RequireAuth>
                <JobDetail />
              </RequireAuth>
            }
          />
        </Routes>
      </Layout>
    </AuthProvider>
  )
}
