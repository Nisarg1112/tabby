import * as React from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { jwtDecode, JwtPayload } from 'jwt-decode'
import useLocalStorage from 'use-local-storage'

import { graphql } from '@/lib/gql/generates'
import { isClientSide } from '@/lib/utils'

import { useIsAdminInitialized } from '../hooks/use-server-info'

interface AuthData {
  accessToken: string
  refreshToken: string
}

function isSameAuthData(lhs: AuthData | undefined, rhs: AuthData | undefined) {
  return (
    lhs?.accessToken === rhs?.accessToken &&
    lhs?.refreshToken === rhs?.refreshToken
  )
}

type AuthState =
  | {
      status: 'authenticated'
      data: AuthData
    }
  | {
      status: 'loading' | 'unauthenticated'
      data: undefined
    }

function isSameAuthState(lhs: AuthState, rhs: AuthState) {
  return lhs.status == rhs.status && isSameAuthData(lhs.data, rhs.data)
}

export enum AuthActionType {
  SignIn,
  SignOut,
  Refresh
}

interface SignInAction {
  type: AuthActionType.SignIn
  data: AuthData
}

interface SignOutAction {
  type: AuthActionType.SignOut
}

interface RefreshAction {
  type: AuthActionType.Refresh
  data: AuthData
}

type AuthActions = SignInAction | SignOutAction | RefreshAction

const AUTH_TOKEN_KEY = '_tabby_auth'

const getAuthToken = (): AuthData | undefined => {
  if (isClientSide()) {
    let tokenData = localStorage.getItem(AUTH_TOKEN_KEY)
    if (!tokenData) return undefined
    try {
      return JSON.parse(tokenData)
    } catch (e) {
      return undefined
    }
  }
  return undefined
}
const saveAuthToken = (authData: AuthData) => {
  localStorage.setItem(AUTH_TOKEN_KEY, JSON.stringify(authData))
}
const clearAuthToken = () => {
  localStorage.removeItem(AUTH_TOKEN_KEY)
  // FIXME(liangfung)
  // dispatching storageEvent to notify updating `authToken` in `AuthProvider`,
  // the `useEffect` hook depending on `authToken` in `AuthProvider` will be fired and updating the authState
  window.dispatchEvent(
    new StorageEvent('storage', {
      storageArea: window.localStorage,
      url: window.location.href,
      key: AUTH_TOKEN_KEY
    })
  )
}

function authReducer(state: AuthState, action: AuthActions): AuthState {
  switch (action.type) {
    case AuthActionType.SignIn:
    case AuthActionType.Refresh:
      return {
        status: 'authenticated',
        data: action.data
      }
    case AuthActionType.SignOut:
      return {
        status: 'unauthenticated',
        data: undefined
      }
  }
}

function authReducerDeduped(state: AuthState, action: AuthActions): AuthState {
  const newState = authReducer(state, action)
  if (isSameAuthState(state, newState)) {
    return state
  } else {
    return newState
  }
}

interface AuthProviderProps {
  children: React.ReactNode
}

interface AuthContextValue extends AuthStore {
  session: Session
}

interface AuthStore {
  authState: AuthState | null
  dispatch: React.Dispatch<AuthActions>
}

const AuthContext = React.createContext<AuthContextValue>(
  {} as AuthContextValue
)

export const refreshTokenMutation = graphql(/* GraphQL */ `
  mutation refreshToken($refreshToken: String!) {
    refreshToken(refreshToken: $refreshToken) {
      accessToken
      refreshToken
    }
  }
`)

const AuthProvider: React.FunctionComponent<AuthProviderProps> = ({
  children
}) => {
  const initialized = React.useRef(false)
  const [authToken] = useLocalStorage<AuthData | undefined>(
    AUTH_TOKEN_KEY,
    undefined
  )
  const [authState, dispatch] = React.useReducer(authReducerDeduped, {
    status: 'loading',
    data: undefined
  })

  React.useEffect(() => {
    initialized.current = true
    if (authToken?.accessToken && authToken?.refreshToken) {
      dispatch({ type: AuthActionType.SignIn, data: authToken })
    } else {
      dispatch({ type: AuthActionType.SignOut })
    }
  }, [])

  React.useEffect(() => {
    if (!initialized.current) return

    // After being mounted, listen for changes in the access token
    if (authToken?.accessToken && authToken?.refreshToken) {
      dispatch({ type: AuthActionType.SignIn, data: authToken })
    } else {
      dispatch({ type: AuthActionType.SignOut })
    }
  }, [authToken])

  const session: Session = React.useMemo(() => {
    if (authState?.status == 'authenticated') {
      try {
        const { sub, is_admin } = jwtDecode<JwtPayload & { is_admin: boolean }>(
          authState.data.accessToken
        )
        return {
          data: {
            email: sub!,
            isAdmin: is_admin,
            accessToken: authState.data.accessToken
          },
          status: authState.status
        }
      } catch (e) {
        console.error('jwt decode failed')
        return {
          status: authState?.status ?? 'loading',
          data: {
            email: '',
            isAdmin: false,
            accessToken: authState.data.accessToken
          }
        }
      }
    }

    return {
      status: authState?.status ?? 'loading',
      data: null
    }
  }, [authState])

  return (
    <AuthContext.Provider value={{ authState, dispatch, session }}>
      {children}
    </AuthContext.Provider>
  )
}

class AuthProviderIsMissing extends Error {
  constructor() {
    super('AuthProvider is missing. Please add the AuthProvider at root level')
  }
}

export function useAuthStore() {
  const context = React.useContext(AuthContext)

  if (!context) {
    throw new AuthProviderIsMissing()
  }

  return context
}

function useSignIn(): (params: AuthData) => Promise<boolean> {
  const { dispatch } = useAuthStore()
  const [authToken, setAuthToken] = useLocalStorage<AuthData | undefined>(
    AUTH_TOKEN_KEY,
    undefined
  )
  return async data => {
    setAuthToken({
      accessToken: data.accessToken,
      refreshToken: data.refreshToken
    })
    dispatch({
      type: AuthActionType.SignIn,
      data
    })

    return true
  }
}

function useSignOut(): () => Promise<void> {
  const { dispatch } = useAuthStore()
  const [authToken, setAuthToken] = useLocalStorage<AuthData | undefined>(
    AUTH_TOKEN_KEY,
    undefined
  )
  return async () => {
    setAuthToken(undefined)
    dispatch({ type: AuthActionType.SignOut })
  }
}

interface User {
  email: string
  isAdmin: boolean
  accessToken: string
}

type Session =
  | {
      data: null
      status: 'loading' | 'unauthenticated'
    }
  | {
      data: User
      status: 'authenticated'
    }

function useSession(): Session {
  const { session } = useAuthStore()
  return session
}

const redirectWhitelist = [
  '/auth/signin',
  '/auth/signup',
  '/auth/reset-password'
]

function useAuthenticatedSession() {
  const isAdminInitialized = useIsAdminInitialized()
  const router = useRouter()
  const pathName = usePathname()
  const { data: session, status } = useSession()

  React.useEffect(() => {
    if (status === 'loading') return
    if (status === 'authenticated') return
    if (isAdminInitialized === undefined) return

    if (!isAdminInitialized) {
      router.replace('/auth/signup?isAdmin=true')
    } else if (!redirectWhitelist.includes(pathName)) {
      router.replace('/auth/signin')
    }
  }, [isAdminInitialized, status])

  return session
}

function useAuthenticatedApi(path: string | null): string | null {
  const { status } = useSession()
  return path && status === 'authenticated' ? path : null
}

export type { AuthStore, User, Session }

export {
  AuthProvider,
  useSignIn,
  useSignOut,
  useSession,
  useAuthenticatedSession,
  useAuthenticatedApi,
  getAuthToken,
  saveAuthToken,
  clearAuthToken,
  AUTH_TOKEN_KEY
}
