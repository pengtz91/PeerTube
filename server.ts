// FIXME: https://github.com/nodejs/node/pull/16853
require('tls').DEFAULT_ECDH_CURVE = 'auto'

import { isTestInstance } from './server/helpers/core-utils'

if (isTestInstance()) {
  require('source-map-support').install()
}

// ----------- Node modules -----------
import * as bodyParser from 'body-parser'
import * as express from 'express'
import * as morgan from 'morgan'
import * as cors from 'cors'
import * as cookieParser from 'cookie-parser'
import * as helmet from 'helmet'
import * as useragent from 'useragent'
import * as anonymize from 'ip-anonymize'
import * as cli from 'commander'

process.title = 'peertube'

// Create our main app
const app = express()

// ----------- Core checker -----------
import { checkMissedConfig, checkFFmpeg } from './server/initializers/checker-before-init'

// Do not use barrels because we don't want to load all modules here (we need to initialize database first)
import { logger } from './server/helpers/logger'
import { API_VERSION, CONFIG, FILES_CACHE } from './server/initializers/constants'

const missed = checkMissedConfig()
if (missed.length !== 0) {
  logger.error('Your configuration files miss keys: ' + missed)
  process.exit(-1)
}

checkFFmpeg(CONFIG)
  .catch(err => {
    logger.error('Error in ffmpeg check.', { err })
    process.exit(-1)
  })

import { checkConfig, checkActivityPubUrls } from './server/initializers/checker-after-init'

const errorMessage = checkConfig()
if (errorMessage !== null) {
  throw new Error(errorMessage)
}

// Trust our proxy (IP forwarding...)
app.set('trust proxy', CONFIG.TRUST_PROXY)

// Security middleware
import { baseCSP } from './server/middlewares/csp'

if (CONFIG.CSP.ENABLED) {
  app.use(baseCSP)
  app.use(helmet({
    frameguard: {
      action: 'deny' // we only allow it for /videos/embed, see server/controllers/client.ts
    },
    hsts: false
  }))
}

// ----------- Database -----------

// Initialize database and models
import { initDatabaseModels } from './server/initializers/database'
import { migrate } from './server/initializers/migrator'
migrate()
  .then(() => initDatabaseModels(false))
  .then(() => startApplication())
  .catch(err => {
    logger.error('Cannot start application.', { err })
    process.exit(-1)
  })

// ----------- PeerTube modules -----------
import { installApplication } from './server/initializers'
import { Emailer } from './server/lib/emailer'
import { JobQueue } from './server/lib/job-queue'
import { VideosPreviewCache, VideosCaptionCache } from './server/lib/files-cache'
import {
  activityPubRouter,
  apiRouter,
  clientsRouter,
  feedsRouter,
  staticRouter,
  servicesRouter,
  webfingerRouter,
  trackerRouter,
  createWebsocketTrackerServer, botsRouter
} from './server/controllers'
import { advertiseDoNotTrack } from './server/middlewares/dnt'
import { Redis } from './server/lib/redis'
import { ActorFollowScheduler } from './server/lib/schedulers/actor-follow-scheduler'
import { RemoveOldJobsScheduler } from './server/lib/schedulers/remove-old-jobs-scheduler'
import { UpdateVideosScheduler } from './server/lib/schedulers/update-videos-scheduler'
import { YoutubeDlUpdateScheduler } from './server/lib/schedulers/youtube-dl-update-scheduler'
import { VideosRedundancyScheduler } from './server/lib/schedulers/videos-redundancy-scheduler'
import { isHTTPSignatureDigestValid } from './server/helpers/peertube-crypto'
import { PeerTubeSocket } from './server/lib/peertube-socket'

// ----------- Command line -----------

cli
  .option('--no-client', 'Start PeerTube without client interface')
  .parse(process.argv)

// ----------- App -----------

// Enable CORS for develop
if (isTestInstance()) {
  app.use(cors({
    origin: '*',
    exposedHeaders: 'Retry-After',
    credentials: true
  }))
}
// For the logger
morgan.token('remote-addr', req => {
  return (req.get('DNT') === '1') ?
    anonymize(req.ip || (req.connection && req.connection.remoteAddress) || undefined,
    16, // bitmask for IPv4
    16  // bitmask for IPv6
    ) :
    req.ip
})
morgan.token('user-agent', req => (req.get('DNT') === '1') ?
  useragent.parse(req.get('user-agent')).family : req.get('user-agent'))
app.use(morgan('combined', {
  stream: { write: logger.info.bind(logger) }
}))
// For body requests
app.use(bodyParser.urlencoded({ extended: false }))
app.use(bodyParser.json({
  type: [ 'application/json', 'application/*+json' ],
  limit: '500kb',
  verify: (req: express.Request, _, buf: Buffer) => {
    const valid = isHTTPSignatureDigestValid(buf, req)
    if (valid !== true) throw new Error('Invalid digest')
  }
}))
// Cookies
app.use(cookieParser())
// W3C DNT Tracking Status
app.use(advertiseDoNotTrack)

// ----------- Views, routes and static files -----------

// API
const apiRoute = '/api/' + API_VERSION
app.use(apiRoute, apiRouter)

// Services (oembed...)
app.use('/services', servicesRouter)

app.use('/', activityPubRouter)
app.use('/', feedsRouter)
app.use('/', webfingerRouter)
app.use('/', trackerRouter)
app.use('/', botsRouter)

// Static files
app.use('/', staticRouter)

// Client files, last valid routes!
if (cli.client) app.use('/', clientsRouter)

// ----------- Errors -----------

// Catch 404 and forward to error handler
app.use(function (req, res, next) {
  const err = new Error('Not Found')
  err['status'] = 404
  next(err)
})

app.use(function (err, req, res, next) {
  let error = 'Unknown error.'
  if (err) {
    error = err.stack || err.message || err
  }

  // Sequelize error
  const sql = err.parent ? err.parent.sql : undefined

  logger.error('Error in controller.', { err: error, sql })
  return res.status(err.status || 500).end()
})

const server = createWebsocketTrackerServer(app)

// ----------- Run -----------

async function startApplication () {
  const port = CONFIG.LISTEN.PORT
  const hostname = CONFIG.LISTEN.HOSTNAME

  await installApplication()

  // Check activity pub urls are valid
  checkActivityPubUrls()
    .catch(err => {
      logger.error('Error in ActivityPub URLs checker.', { err })
      process.exit(-1)
    })

  // Email initialization
  Emailer.Instance.init()

  await Promise.all([
    Emailer.Instance.checkConnectionOrDie(),
    JobQueue.Instance.init()
  ])

  // Caches initializations
  VideosPreviewCache.Instance.init(CONFIG.CACHE.PREVIEWS.SIZE, FILES_CACHE.PREVIEWS.MAX_AGE)
  VideosCaptionCache.Instance.init(CONFIG.CACHE.VIDEO_CAPTIONS.SIZE, FILES_CACHE.VIDEO_CAPTIONS.MAX_AGE)

  // Enable Schedulers
  ActorFollowScheduler.Instance.enable()
  RemoveOldJobsScheduler.Instance.enable()
  UpdateVideosScheduler.Instance.enable()
  YoutubeDlUpdateScheduler.Instance.enable()
  VideosRedundancyScheduler.Instance.enable()

  // Redis initialization
  Redis.Instance.init()

  PeerTubeSocket.Instance.init(server)

  // Make server listening
  server.listen(port, hostname, () => {
    logger.info('Server listening on %s:%d', hostname, port)
    logger.info('Web server: %s', CONFIG.WEBSERVER.URL)
  })

  process.on('exit', () => {
    JobQueue.Instance.terminate()
  })

  process.on('SIGINT', () => process.exit(0))
}
