import 'reflect-metadata'
import { jest } from '@jest/globals'
import type { Connection } from 'typeorm'
import TypeORM from 'typeorm'
const { LessThan } = TypeORM
import { DateUtils } from 'typeorm/util/DateUtils'
import { DBConnection } from '../../services/__tests__/db-connection.js'
import { container } from 'tsyringe'
import { config } from 'node-config-ts'
import { RequestRepository } from '../request-repository.js'
import { AnchorRepository } from '../anchor-repository.js'
import { Request } from '../../models/request.js'
import { randomCID } from '../../test-utils.js'
import { StreamID } from '@ceramicnetwork/streamid'
import { RequestStatus } from '../../models/request-status.js'

const MS_IN_MINUTE = 1000 * 60
const MS_IN_HOUR = MS_IN_MINUTE * 60
const MS_IN_DAY = MS_IN_HOUR * 24
const MS_IN_MONTH = MS_IN_DAY * 30

const generateRequests = async (override: Partial<Request>, count = 1): Promise<Request[]> => {
  const requests = await Promise.all(
    Array.from(Array(count)).map(async (_, i) => {
      const request = new Request()
      const cid = await randomCID()
      request.cid = cid.toString()
      request.streamId = new StreamID('tile', cid).toString()
      request.status = RequestStatus.PENDING
      request.createdAt = new Date(Date.now() - Math.random() * MS_IN_HOUR)
      request.updatedAt = new Date(request.createdAt.getTime())

      Object.assign(request, override)

      const variance = Math.random() * 5
      request.createdAt = new Date(request.createdAt.getTime() + MS_IN_MINUTE * (i + variance))
      request.updatedAt = new Date(request.updatedAt.getTime() + MS_IN_MINUTE * (i + variance))
      return request
    })
  )

  return requests
}

async function generateCompletedRequest(expired: boolean, failed: boolean): Promise<Request> {
  const request = new Request()
  const cid = await randomCID()
  request.cid = cid.toString()
  request.streamId = new StreamID('tile', cid).toString()
  request.status = failed ? RequestStatus.FAILED : RequestStatus.COMPLETED
  request.message = 'cid anchored successfully'
  request.pinned = true

  const now = new Date()
  request.createdAt = new Date(now.getFullYear(), now.getMonth() - 3, now.getDate())
  if (expired) {
    // Request was last updated over a month ago
    request.updatedAt = new Date(now.getFullYear(), now.getMonth() - 2, now.getDate())
  } else {
    // Request was last updated less than a week ago
    request.updatedAt = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 5)
  }

  return request
}

async function generatePendingRequests(count: number): Promise<Request[]> {
  const now = new Date()
  const requests = []

  for (let i = 0; i < count; i++) {
    const request = new Request()
    const cid = await randomCID()
    request.cid = cid.toString()
    request.streamId = new StreamID('tile', cid).toString()
    request.status = RequestStatus.PENDING
    const createdAt = new Date(now)
    createdAt.setHours(now.getHours() + i)
    request.createdAt = createdAt

    requests.push(request)
  }

  return requests
}

async function getAllRequests(connection): Promise<Request[]> {
  return await connection
    .getRepository(Request)
    .createQueryBuilder('request')
    .orderBy('request.createdAt', 'ASC')
    .getMany()
}

describe('request repository test', () => {
  jest.setTimeout(10000)
  let connection: Connection

  beforeAll(async () => {
    connection = await DBConnection.create()

    container.registerInstance('config', config)
    container.registerInstance('dbConnection', connection)
    container.registerSingleton('anchorRepository', AnchorRepository)
    container.registerSingleton('requestRepository', RequestRepository)
  })

  beforeEach(async () => {
    await DBConnection.clear(connection)
  })

  afterAll(async () => {
    await DBConnection.close(connection)
  })

  test('Finds requests older than a month', async () => {
    const requestRepository = container.resolve<RequestRepository>('requestRepository')

    // Create two requests that are expired and should be garbage collected, and two that should not
    // be.
    const requests = await Promise.all([
      generateCompletedRequest(false, false),
      generateCompletedRequest(true, false),
      generateCompletedRequest(false, true),
      generateCompletedRequest(true, true),
    ])

    await requestRepository.createRequests(requests)

    const expiredRequests = await requestRepository.findRequestsToGarbageCollect()
    expect(expiredRequests.length).toEqual(2)
    expect(expiredRequests[0].cid).toEqual(requests[1].cid)
    expect(expiredRequests[1].cid).toEqual(requests[3].cid)
  })

  test("Don't cleanup streams who have both old and new requests", async () => {
    const requestRepository = container.resolve<RequestRepository>('requestRepository')

    // Create two requests that are expired and should be garbage collected, and two that should not
    // be.
    const requests = await Promise.all([
      generateCompletedRequest(false, false),
      generateCompletedRequest(true, false),
      generateCompletedRequest(false, true),
      generateCompletedRequest(true, true),
    ])

    // Set an expired and non-expired request to be on the same streamId. The expired request should
    // not show up to be garbage collected.
    requests[3].streamId = requests[2].streamId

    await requestRepository.createRequests(requests)

    const expiredRequests = await requestRepository.findRequestsToGarbageCollect()
    expect(expiredRequests.length).toEqual(1)
    expect(expiredRequests[0].cid).toEqual(requests[1].cid)
  })

  test('Process requests oldest to newest', async () => {
    const requestRepository = container.resolve<RequestRepository>('requestRepository')

    const requests = await generatePendingRequests(2)
    await requestRepository.createRequests(requests)
    const loadedRequests = await requestRepository.findNextToProcess(100)

    expect(loadedRequests.length).toEqual(2)
    expect(loadedRequests[0].createdAt.getTime()).toBeLessThan(
      loadedRequests[1].createdAt.getTime()
    )
    expect(loadedRequests[0].cid).toEqual(requests[0].cid)
    expect(loadedRequests[1].cid).toEqual(requests[1].cid)
  })

  describe('findAndMarkReady', () => {
    test('Marks pending requests as ready', async () => {
      const streamLimit = 5
      const requests = await Promise.all([
        generateRequests({ status: RequestStatus.PENDING }, streamLimit),
        generateRequests(
          {
            status: RequestStatus.COMPLETED,
            createdAt: new Date(Date.now() - 2 * MS_IN_MONTH),
            updatedAt: new Date(Date.now() - MS_IN_MONTH),
            pinned: true,
          },
          2
        ),
      ]).then((arr) => arr.flat())

      const requestRepository = container.resolve<RequestRepository>('requestRepository')
      await requestRepository.createRequests(requests)

      const createdRequests = await getAllRequests(connection)
      expect(requests.length).toEqual(createdRequests.length)

      const updatedRequests = await requestRepository.findAndMarkReady(streamLimit)
      expect(updatedRequests.length).toEqual(streamLimit)

      const pendingRequests = createdRequests.filter(
        ({ status }) => RequestStatus.PENDING === status
      )
      expect(updatedRequests.map(({ cid }) => cid)).toEqual(pendingRequests.map(({ cid }) => cid))
    })

    test('Marks no requests as ready if there are not enough streams', async () => {
      const streamLimit = 5
      const requests = await Promise.all([
        generateRequests({ status: RequestStatus.PENDING }, streamLimit - 1),
        generateRequests(
          {
            status: RequestStatus.FAILED,
            createdAt: new Date(Date.now() - 2 * MS_IN_MONTH),
            updatedAt: new Date(Date.now() - MS_IN_MONTH),
            pinned: true,
          },
          2
        ),
      ]).then((arr) => arr.flat())

      const requestRepository = container.resolve<RequestRepository>('requestRepository')
      await requestRepository.createRequests(requests)

      const updatedRequests = await requestRepository.findAndMarkReady(streamLimit)
      expect(updatedRequests.length).toEqual(0)
    })

    test('Marks expired pending request as ready even if there are not enough streams', async () => {
      const streamLimit = 5
      const requests = await Promise.all([
        generateRequests(
          {
            status: RequestStatus.PENDING,
            createdAt: new Date(Date.now() - MS_IN_HOUR * 13),
            updatedAt: new Date(Date.now() - MS_IN_HOUR * 13),
          },
          1
        ),
        generateRequests({ status: RequestStatus.PENDING }, 1),
      ]).then((arr) => arr.flat())

      const requestRepository = container.resolve<RequestRepository>('requestRepository')
      await requestRepository.createRequests(requests)

      const createdRequests = await getAllRequests(connection)
      expect(requests.length).toEqual(createdRequests.length)

      const updatedRequests = await requestRepository.findAndMarkReady(streamLimit)
      expect(updatedRequests.length).toEqual(createdRequests.length)

      expect(updatedRequests.map(({ cid }) => cid)).toEqual(createdRequests.map(({ cid }) => cid))
    })

    test('Marks only streamLimit requests as READY even if there are more', async () => {
      const streamLimit = 5
      const requests = await generateRequests({ status: RequestStatus.PENDING }, streamLimit + 2)

      const requestRepository = container.resolve<RequestRepository>('requestRepository')
      await requestRepository.createRequests(requests)

      const createdRequests = await getAllRequests(connection)
      expect(createdRequests.length).toEqual(requests.length)

      const updatedRequests = await requestRepository.findAndMarkReady(streamLimit)
      expect(updatedRequests.length).toEqual(streamLimit)

      const earliestPendingRequestCids = createdRequests.map(({ cid }) => cid).slice(0, streamLimit)

      expect(updatedRequests.map(({ cid }) => cid)).toEqual(earliestPendingRequestCids)
    })

    test('Marks processing requests as ready if they need to be retried', async () => {
      const streamLimit = 5
      const expiredProcessing = await generateRequests(
        {
          status: RequestStatus.PROCESSING,
          createdAt: new Date(Date.now() - MS_IN_HOUR * 24),
          updatedAt: new Date(Date.now() - MS_IN_HOUR * 7),
        },
        1
      )
      const requests = await Promise.all([
        expiredProcessing,
        // requests that are current processing
        generateRequests(
          {
            status: RequestStatus.PROCESSING,
            createdAt: new Date(Date.now() - MS_IN_HOUR * 3),
            updatedAt: new Date(Date.now() - MS_IN_HOUR * 2),
          },
          4
        ),
        //pending requests
        generateRequests({ status: RequestStatus.PENDING }, streamLimit),
      ]).then((arr) => arr.flat())

      const requestRepository = container.resolve<RequestRepository>('requestRepository')
      await requestRepository.createRequests(requests)

      const createdRequests = await getAllRequests(connection)
      expect(createdRequests.length).toEqual(requests.length)

      const updatedRequests = await requestRepository.findAndMarkReady(streamLimit)
      expect(updatedRequests.length).toEqual(streamLimit)

      // get earliest 4 pending as the expired processing request should be the first one
      const earliestPendingRequestCids = createdRequests
        .filter(({ status }) => status === RequestStatus.PENDING)
        .slice(0, streamLimit - 1)
        .map(({ cid }) => cid)

      expect(updatedRequests.map(({ cid }) => cid)).toEqual([
        expiredProcessing[0].cid,
        ...earliestPendingRequestCids,
      ])
    })

    test('Marks requests for same streams as ready', async () => {
      const streamLimit = 5
      const repeatedStreamId = new StreamID('tile', await randomCID()).toString()
      const requests = await Promise.all([
        generateRequests(
          {
            status: RequestStatus.PROCESSING,
            createdAt: new Date(Date.now() - MS_IN_HOUR * 24),
            updatedAt: new Date(Date.now() - MS_IN_HOUR * 7),
            streamId: repeatedStreamId,
          },
          1
        ),
        generateRequests(
          {
            status: RequestStatus.PENDING,
            streamId: repeatedStreamId,
          },
          1
        ),
        generateRequests(
          {
            status: RequestStatus.PENDING,
          },
          streamLimit
        ),
      ]).then((arr) => arr.flat())
      const expiredProcessingRequest = requests[0]
      const reRequested = requests[1]

      const requestRepository = container.resolve<RequestRepository>('requestRepository')
      await requestRepository.createRequests(requests)

      const createdRequest = await getAllRequests(connection)
      expect(createdRequest.length).toEqual(requests.length)

      const updatedRequests = await requestRepository.findAndMarkReady(streamLimit)
      expect(updatedRequests.length).toEqual(streamLimit + 1)

      const updatedRequestCids = updatedRequests.map(({ cid }) => cid)
      expect(updatedRequestCids).toContain(expiredProcessingRequest.cid)
      expect(updatedRequestCids).toContain(reRequested.cid)
    })

    test('Does not mark any transaction as ready if an error occurs', async () => {
      const streamLimit = 5
      const requests = await generateRequests(
        {
          status: RequestStatus.PENDING,
        },
        streamLimit
      )

      const requestRepository = container.resolve<RequestRepository>('requestRepository')
      await requestRepository.createRequests(requests)

      const originaUpdateRequest = requestRepository.updateRequests
      requestRepository.updateRequests = (fields, requests, manager) => {
        throw new Error('test error')
      }

      try {
        await requestRepository.findAndMarkReady(streamLimit).catch(() => {})
        const requestsAfterUpdate = await getAllRequests(connection)
        expect(requestsAfterUpdate.length).toEqual(requests.length)
        expect(requestsAfterUpdate.every(({ status }) => status === RequestStatus.PENDING)).toEqual(
          true
        )
      } finally {
        requestRepository.updateRequests = originaUpdateRequest
      }
    })
  })

  test.only('stephs demo that snakecase does not work in select', async () => {
    const numStreams = 10
    const requests = await generateRequests({ status: RequestStatus.PENDING }, numStreams)
    const requestRepository = container.resolve<RequestRepository>('requestRepository')
    await requestRepository.createRequests(requests)

    const notEmptyCamelCase = await connection
      .getRepository(Request)
      .createQueryBuilder('request')
      .select('request.createdAt')
      .orderBy('request.created_at', 'ASC')
      .getMany()
    expect(notEmptyCamelCase.length).toEqual(numStreams)

    const emptySnakeCase = await connection
      .getRepository(Request)
      .createQueryBuilder('request')
      .select('request.created_at')
      .orderBy('request.createdAt', 'ASC')
      .getMany()
    expect(emptySnakeCase.length).toEqual(0)
  })

  test.only('stephs demo that date is weird', async () => {
    const testDate = new Date('2000-01-01T00:00Z')
    const requests = await generateRequests(
      {
        status: RequestStatus.PENDING,
      },
      1
    )

    requests[0].createdAt = testDate
    requests[0].updatedAt = testDate

    const requestRepository = container.resolve<RequestRepository>('requestRepository')
    await requestRepository.createRequests(requests)

    const createdRequest = await getAllRequests(connection)
    expect(createdRequest.length).toEqual(requests.length)
    expect(new Date(createdRequest[0].createdAt).toISOString()).toEqual(testDate.toISOString())

    const foundUsingIsoString = await connection
      .getRepository(Request)
      .createQueryBuilder('request')
      .andWhere('request.created_at = :date', { date: testDate.toISOString() })
      .getMany()

    expect(foundUsingIsoString.length).toEqual(0)

    const foundUsingFormat = await connection
      .getRepository(Request)
      .createQueryBuilder('request')
      .where('request.created_at = :date', {
        date: DateUtils.mixedDateToUtcDatetimeString(testDate),
      })
      .getMany()

    expect(foundUsingFormat.length).toEqual(1)

    const foundUsingLessThan = await connection
      .getRepository(Request)
      .createQueryBuilder('request')
      .where({ updatedAt: LessThan(testDate) })
      .getMany()

    expect(foundUsingLessThan.length).toEqual(1)
  })
})
