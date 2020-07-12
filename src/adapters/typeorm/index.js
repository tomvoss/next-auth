import { createConnection, getConnection, getManager } from 'typeorm'
import { createHash } from 'crypto'

import { CreateUserError } from '../../lib/errors'
import adapterConfig from './lib/config'
import adapterTransform from './lib/transform'
import Models from './models'
import logger from '../../lib/logger'

const Adapter = (typeOrmConfig, options = {}) => {
  // Ensure typeOrmConfigObject is normalized to an object
  const typeOrmConfigObject = (typeof typeOrmConfig === 'string')
    ? adapterConfig.parseConnectionString(typeOrmConfig)
    : typeOrmConfig

  // Load any custom models passed as an option, default to built in models
  const { models: customModels = {} } = options
  const models = {
    User: customModels.User ? customModels.User : Models.User,
    Account: customModels.Account ? customModels.Account : Models.Account,
    Session: customModels.Session ? customModels.Session : Models.Session,
    VerificationRequest: customModels.VerificationRequest ? customModels.VerificationRequest : Models.VerificationRequest
  }

  // The models are designed for ANSI SQL databases first (as a baseline).
  // For databases that use a different pragma, we transform the models at run
  // time *unless* the models are user supplied (in which case we don't do
  // anything to do them). This function updates arguments by reference.
  adapterTransform(typeOrmConfigObject, models, options)

  const config = adapterConfig.loadConfig(typeOrmConfigObject, { ...options, models })

  // Create objects from models that can be consumed by functions in the adapter
  const User = models.User.model
  const Account = models.Account.model
  const Session = models.Session.model
  const VerificationRequest = models.VerificationRequest.model

  let connection = null

  async function getAdapter (appOptions) {
    // Helper function to reuse / restablish connections
    // (useful if they drop when after being idle)
    async function _connect () {
      // Get current connection by name
      connection = getConnection(config.name)

      // If connection is no longer established, reconnect
      if (!connection.isConnected) { connection = await connection.connect() }
    }

    if (!connection) {
      // If no connection, create new connection
      try {
        connection = await createConnection(config)
      } catch (error) {
        if (error.name === 'AlreadyHasActiveConnectionError') {
          // If creating connection fails because it's already
          // been re-established, check it's really up
          await _connect()
        } else {
          logger.error('ADAPTER_CONNECTION_ERROR', error)
        }
      }
    } else {
      // If the connection object already exists, ensure it's valid
      await _connect()
    }

    // Display debug output if debug option enabled
    // @TODO Refactor logger so is passed in appOptions
    function debugMessage (debugCode, ...args) {
      if (appOptions && appOptions.debug) {
        logger.debug(`TYPEORM_${debugCode}`, ...args)
      }
    }

    // The models are primarily designed for ANSI SQL database, but some
    // flexiblity is required in the adapter to support non-SQL databases such
    // as MongoDB which have different pragmas.
    //
    // TypeORM does some abstraction, but doesn't handle everything (e.g. it
    // handles translating `id` and `_id` in models, but not queries) so we
    // need to handle somethings in the adapter to make it compatible.
    let idKey = 'id'
    let ObjectId
    if (config.type === 'mongodb') {
      idKey = '_id'
      const mongodb = await import('mongodb')
      ObjectId = mongodb.ObjectId
    }

    // These values are stored as seconds, but to use them with dates in
    // JavaScript we convert them to milliseconds.
    //
    // Use a conditional to default to 30 day session age if not set - it should
    // always be set but a meaningful fallback is helpful to facilitate testing.
    if (appOptions && (!appOptions.session || !appOptions.session.maxAge)) {
      debugMessage('GET_ADAPTER', 'Session expiry not configured (defaulting to 30 days')
    }
    const defaultSessionMaxAge = 30 * 24 * 60 * 60 * 1000
    const sessionMaxAge = (appOptions && appOptions.session && appOptions.session.maxAge)
      ? appOptions.session.maxAge * 1000
      : defaultSessionMaxAge
    const sessionUpdateAge = (appOptions && appOptions.session && appOptions.session.updateAge)
      ? appOptions.session.updateAge * 1000
      : 0

    async function createUser (profile) {
      debugMessage('CREATE_USER', profile)
      try {
        // Create user account
        const user = new User(profile.name, profile.email, profile.image, profile.emailVerified)
        return await getManager().save(user)
      } catch (error) {
        logger.error('CREATE_USER_ERROR', error)
        return Promise.reject(new CreateUserError(error))
      }
    }

    async function getUser (id) {
      debugMessage('GET_USER', id)

      // In the very specific case of both using JWT for storing session data
      // and using MongoDB to store user data, the ID is a string rather than
      // an ObjectId and we need to turn it into an ObjectId.
      //
      // In all other scenarios it is already an ObjectId, because it will have
      // come from another MongoDB query.
      if (ObjectId && !(id instanceof ObjectId)) {
        id = ObjectId(id)
      }

      try {
        return connection.getRepository(User).findOne({ [idKey]: id })
      } catch (error) {
        logger.error('GET_USER_BY_ID_ERROR', error)
        return Promise.reject(new Error('GET_USER_BY_ID_ERROR', error))
      }
    }

    async function getUserByEmail (email) {
      debugMessage('GET_USER_BY_EMAIL', email)
      try {
        if (!email) { return Promise.resolve(null) }
        return connection.getRepository(User).findOne({ email })
      } catch (error) {
        logger.error('GET_USER_BY_EMAIL_ERROR', error)
        return Promise.reject(new Error('GET_USER_BY_EMAIL_ERROR', error))
      }
    }

    async function getUserByProviderAccountId (providerId, providerAccountId) {
      debugMessage('GET_USER_BY_PROVIDER_ACCOUNT_ID', providerId, providerAccountId)
      try {
        const account = await connection.getRepository(Account).findOne({ providerId, providerAccountId })
        if (!account) { return null }
        return connection.getRepository(User).findOne({ [idKey]: account.userId })
      } catch (error) {
        logger.error('GET_USER_BY_PROVIDER_ACCOUNT_ID_ERROR', error)
        return Promise.reject(new Error('GET_USER_BY_PROVIDER_ACCOUNT_ID_ERROR', error))
      }
    }

    async function updateUser (user) {
      debugMessage('UPDATE_USER', user)
      return getManager().save(user)
    }

    async function deleteUser (userId) {
      debugMessage('DELETE_USER', userId)
      // @TODO Delete user from DB
      return false
    }

    async function linkAccount (userId, providerId, providerType, providerAccountId, refreshToken, accessToken, accessTokenExpires) {
      debugMessage('LINK_ACCOUNT', userId, providerId, providerType, providerAccountId, refreshToken, accessToken, accessTokenExpires)
      try {
        // Create provider account linked to user
        const account = new Account(userId, providerId, providerType, providerAccountId, refreshToken, accessToken, accessTokenExpires)
        return getManager().save(account)
      } catch (error) {
        logger.error('LINK_ACCOUNT_ERROR', error)
        return Promise.reject(new Error('LINK_ACCOUNT_ERROR', error))
      }
    }

    async function unlinkAccount (userId, providerId, providerAccountId) {
      debugMessage('UNLINK_ACCOUNT', userId, providerId, providerAccountId)
      // @TODO Get current user from DB
      // @TODO Delete [provider] object from user object
      // @TODO Save changes to user object in DB
      return false
    }

    async function getAccounts (id) {
      debugMessage('GET_ACCOUNTS', id)
      try {
        const accounts = await connection.getRepository(Account).find({ userId: id })
        if (!accounts) { return null }
        return accounts
      } catch (error) {
        logger.error('GET_ACCOUNTS_ERROR', error)
        return Promise.reject(new Error('GET_ACCOUNTS_ERROR', error))
      }
    }

    async function createSession (user) {
      debugMessage('CREATE_SESSION', user)
      try {
        let expires = null
        if (sessionMaxAge) {
          const dateExpires = new Date()
          dateExpires.setTime(dateExpires.getTime() + sessionMaxAge)
          expires = dateExpires
        }
 
        const session = new Session(user.id, expires)

        return getManager().save(session)
      } catch (error) {
        logger.error('CREATE_SESSION_ERROR', error)
        return Promise.reject(new Error('CREATE_SESSION_ERROR', error))
      }
    }

    async function getSession (sessionToken) {
      debugMessage('GET_SESSION', sessionToken)
      try {
        const session = await connection.getRepository(Session).findOne({ sessionToken })

        // Check session has not expired (do not return it if it has)
        if (session && session.expires && new Date() > new Date(session.expires)) {
          // @TODO Delete old sessions from database
          return null
        }

        return session
      } catch (error) {
        logger.error('GET_SESSION_ERROR', error)
        return Promise.reject(new Error('GET_SESSION_ERROR', error))
      }
    }

    async function updateSession (session, force) {
      debugMessage('UPDATE_SESSION', session)
      try {
        if (sessionMaxAge && (sessionUpdateAge || sessionUpdateAge === 0) && session.expires) {
          // Calculate last updated date, to throttle write updates to database
          // Formula: ({expiry date} - sessionMaxAge) + sessionUpdateAge
          //     e.g. ({expiry date} - 30 days) + 1 hour
          //
          // Default for sessionMaxAge is 30 days.
          // Default for sessionUpdateAge is 1 hour.
          const dateSessionIsDueToBeUpdated = new Date(session.expires)
          dateSessionIsDueToBeUpdated.setTime(dateSessionIsDueToBeUpdated.getTime() - sessionMaxAge)
          dateSessionIsDueToBeUpdated.setTime(dateSessionIsDueToBeUpdated.getTime() + sessionUpdateAge)

          // Trigger update of session expiry date and write to database, only
          // if the session was last updated more than {sessionUpdateAge} ago
          if (new Date() > dateSessionIsDueToBeUpdated) {
            const newExpiryDate = new Date()
            newExpiryDate.setTime(newExpiryDate.getTime() + sessionMaxAge)
            session.expires = newExpiryDate
          } else if (!force) {
            return null
          }
        } else {
          // If session MaxAge, session UpdateAge or session.expires are
          // missing then don't even try to save changes, unless force is set.
          if (!force) { return null }
        }

        return getManager().save(session)
      } catch (error) {
        logger.error('UPDATE_SESSION_ERROR', error)
        return Promise.reject(new Error('UPDATE_SESSION_ERROR', error))
      }
    }

    async function deleteSession (sessionToken) {
      debugMessage('DELETE_SESSION', sessionToken)
      try {
        return await connection.getRepository(Session).delete({ sessionToken })
      } catch (error) {
        logger.error('DELETE_SESSION_ERROR', error)
        return Promise.reject(new Error('DELETE_SESSION_ERROR', error))
      }
    }

    async function createVerificationRequest (identifier, url, token, secret, provider) {
      debugMessage('CREATE_VERIFICATION_REQUEST', identifier)
      try {
        const { baseUrl } = appOptions
        const { sendVerificationRequest, maxAge } = provider

        // Store hashed token (using secret as salt) so that tokens cannot be exploited
        // even if the contents of the database is compromised.
        // @TODO Use bcrypt function here instead of simple salted hash
        const hashedToken = createHash('sha256').update(`${token}${secret}`).digest('hex')

        let expires = null
        if (maxAge) {
          const dateExpires = new Date()
          dateExpires.setTime(dateExpires.getTime() + (maxAge * 1000))
          expires = dateExpires
        }

        // Save to database
        const newVerificationRequest = new VerificationRequest(identifier, hashedToken, expires)
        const verificationRequest = await getManager().save(newVerificationRequest)

        // With the verificationCallback on a provider, you can send an email, or queue
        // an email to be sent, or perform some other action (e.g. send a text message)
        await sendVerificationRequest({ identifier, url, token, baseUrl, provider })

        return verificationRequest
      } catch (error) {
        logger.error('CREATE_VERIFICATION_REQUEST_ERROR', error)
        return Promise.reject(new Error('CREATE_VERIFICATION_REQUEST_ERROR', error))
      }
    }

    async function getVerificationRequest (identifier, token, secret, provider) {
      debugMessage('GET_VERIFICATION_REQUEST', identifier, token)
      try {
        // Hash token provided with secret before trying to match it with database
        // @TODO Use bcrypt instead of salted SHA-256 hash for token
        const hashedToken = createHash('sha256').update(`${token}${secret}`).digest('hex')
        const verificationRequest = await connection.getRepository(VerificationRequest).findOne({ identifier, token: hashedToken })

        if (verificationRequest && verificationRequest.expires && new Date() > new Date(verificationRequest.expires)) {
          // Delete verification entry so it cannot be used again
          await connection.getRepository(VerificationRequest).delete({ token: hashedToken })
          return null
        }

        return verificationRequest
      } catch (error) {
        logger.error('GET_VERIFICATION_REQUEST_ERROR', error)
        return Promise.reject(new Error('GET_VERIFICATION_REQUEST_ERROR', error))
      }
    }

    async function deleteVerificationRequest (identifier, token, secret, provider) {
      debugMessage('DELETE_VERIFICATION', identifier, token)
      try {
        // Delete verification entry so it cannot be used again
        const hashedToken = createHash('sha256').update(`${token}${secret}`).digest('hex')
        await connection.getRepository(VerificationRequest).delete({ token: hashedToken })
      } catch (error) {
        logger.error('DELETE_VERIFICATION_REQUEST_ERROR', error)
        return Promise.reject(new Error('DELETE_VERIFICATION_REQUEST_ERROR', error))
      }
    }

    return Promise.resolve({
      createUser,
      getUser,
      getUserByEmail,
      getUserByProviderAccountId,
      updateUser,
      deleteUser,
      linkAccount,
      unlinkAccount,
      getAccounts,
      createSession,
      getSession,
      updateSession,
      deleteSession,
      createVerificationRequest,
      getVerificationRequest,
      deleteVerificationRequest
    })
  }

  return {
    getAdapter
  }
}

export default {
  Adapter,
  Models
}
