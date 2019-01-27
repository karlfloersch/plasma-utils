const BigNum = require('bn.js')

// TODO: Maybe make these functions into static methods?
/**
 * Validates a range.
 * - Range start should be >= 0
 * - Range start should be < range end
 * @param {*} range A range object.
 * @return {boolean} `true` if the range is valid, `false` otherwise.
 */
function isValidRange (range) {
  // TODO: Check that the token is valid.
  return range.start.gte(0) && range.start.lt(range.end)
}

/**
 * Orders the provided ranges, collapsing them if possible
 * @param {*} rangeA A range object.
 * @param {*} rangeB A range object.
 * @return {array} array of ordered ranges
 */
function orderRanges (rangeA, rangeB) {
  // No curRange and new range comes before current range
  if (rangeA.end.lt(rangeB.start)) {
    return [rangeA, rangeB]
  } else if (rangeA.start.eq(rangeB.end)) {
    // No curRange and new range start == current range end
    // merge to end of current range
    rangeB.end = rangeA.end
    return [rangeB]
  } else if (rangeA.end.eq(rangeB.start)) {
    // If new range end == current range start
    // merge to front of current range
    rangeB.start = rangeA.start
    return [rangeB]
  } else {
    return [rangeB, rangeA]
  }
}

/**
 * Checks is an array of ranges contains another range
 * @param {array} ranges An array of ranges to check.
 * @param {*} range A range object.
 * @return {boolean} `true` if the user owns the range, `false` otherwise.
 */
function containsRange (ranges, range) {
  return ranges.some(
    ({ start: ownedRangeStart, end: ownedRangeEnd }) =>
      ownedRangeStart.lte(range.start) && ownedRangeEnd.gte(range.end)
  )
}

/**
 * Creates a range object
 * @param {String} token Tokens address.
 * @param {Number} start Range start.
 * @param {Number} end Range end.
 * @return {Range} Range object
 */
function createRange (token, start, end) {
  return {
    token: new BigNum(token, 'hex'),
    start: new BigNum(start, 'hex'),
    end: new BigNum(end, 'hex')
  }
}

/**
 * Service that manages the user's ranges automatically.
 */
class RangeManagerService {
  /**
   * Returns the list of ranges owned by an address.
   * @param {string} address An address.
   * @return {Array} List of owned ranges.
   */
  async getOwnedRanges (address) {
    return this._getRanges(address)
  }

  /**
   * Returns a list of ranges relevant to a transaction.
   * @param {*} transaction A Transaction object.
   * @return {Array} List of ranges relevant to that transaction.
   */
  async getRelevantRanges (transaction) {
    let ranges = []
    for (let transfer of transaction.transfers) {
      ranges.concat(await this.getOwnedRanges(transfer.sender))
    }
    return ranges
  }

  /**
   * Determines if an address owners a specific range.
   * i.e. if a user owns range [0, 100] and this method is
   * called with [10, 30], it will return true.
   * @param {string} address An address.
   * @param {*} range A range object.
   * @return {boolean} `true` if the user owns the range, `false` otherwise.
   */
  async ownsRange (address, range) {
    range = this._castRange(range)

    const ownedRanges = await this.getOwnedRanges(address)
    return containsRange(ownedRanges, range)
  }

  /**
   * Picks the best ranges for a given transaction.
   * @param {string} address An address.
   * @param {string} token A tokens address.
   * @param {number} amount Number of tokens being sent.
   * @return {*} List of ranges to use for the transaction.
   */
  async pickRanges (address, token, amount) {
    token = new BigNum(token, 'hex')
    amount = new BigNum(amount, 'hex')

    const ownedRanges = await this.getOwnedRanges(address)
    const sortedRanges = ownedRanges.sort((a, b) =>
      b.end.sub(b.start).sub(a.end.sub(a.start))
    )
    const pickedRanges = []

    while (amount.gt(new BigNum(0))) {
      // throw if no ranges left
      if (sortedRanges.length === 0) {
        throw new Error(
          'Address does not own enough ranges to cover the amount.'
        )
      }

      const smallestRange = sortedRanges.pop()

      if (smallestRange.token.eq(token)) {
        const smallestRangeLength = smallestRange.end.sub(smallestRange.start)

        if (smallestRangeLength.lte(amount)) {
          pickedRanges.push(smallestRange)
          amount = amount.sub(smallestRangeLength)
        } else {
          // Pick a partial range
          const partialRange = createRange(
            smallestRange.token,
            smallestRange.start,
            smallestRange.start.add(amount)
          )
          pickedRanges.push(partialRange)
          break
        }
      }
    }

    pickedRanges.sort((a, b) => a.start.sub(b.start))
    return pickedRanges
  }

  /**
   * Determines if an account can spend an amount of a token.
   * @param {*} address An address
   * @param {string} token A tokens address.
   * @param {*} amount Number of tokens being sent.
   * @return {boolean} `true` if the user can spend the tokens, `false` otherwise.
   */
  async canSpend (address, token, amount) {
    try {
      await this.pickRanges(address, token, amount)
      return true
    } catch (err) {
      return false
    }
  }

  /**
   * Adds a range for a given user.
   * @param {*} address An address.
   * @param {array} range A range to add.
   */
  async addRange (address, range) {
    await this.addRanges(address, [range])
  }

  /**
   * Adds ranges for a given user.
   * @param {*} address An address.
   * @param {string} token A tokens address.
   * @param {*} ranges Ranges to add.
   */
  async addRanges (address, ranges) {
    ranges = this._castRanges(ranges)

    // Throw if provided range is invalid
    if (ranges.some((range) => !isValidRange(range))) {
      throw new Error(`Invalid range provided: ${ranges}`)
    }

    const ownedRanges = (await this.getOwnedRanges(address)) || []

    // If there are no owned ranges,
    // just sort and add the new ranges
    if (ownedRanges.length === 0) {
      ranges.sort((a, b) => a.start.sub(b.start))
      return this._setRanges(address, ranges)
    }

    ranges = ranges.concat(ownedRanges)
    ranges.sort((a, b) => a.start.sub(b.start))

    const nextRanges = ranges.reduce((nextRanges, newRange) => {
      if (nextRanges.length === 0) {
        return [newRange]
      }
      const lastRange = nextRanges.pop()
      return nextRanges.concat(orderRanges(lastRange, newRange))
    }, [])

    return this._setRanges(address, nextRanges)
  }

  /**
   * Removes a range for a given user.
   * @param {*} address An address.
   * @param {*} range A range to remove.
   */
  async removeRange (address, range) {
    return this.removeRanges(address, [range])
  }

  /**
   * Removes a sequence of ranges for a given user.
   * @param {*} address An address.
   * @param {*} ranges An array of ranges to remove.
   */
  async removeRanges (address, ranges) {
    ranges = this._castRanges(ranges)

    const ownedRanges = await this.getOwnedRanges(address)

    if (ranges.some((range) => !containsRange(ownedRanges, range))) {
      throw new Error(`Attempted to remove a range not owned by address.`)
    }

    ranges.sort((a, b) => b.start.sub(a.start))

    let toRemove = ranges.pop()
    const nextRanges = ownedRanges.reduce((nextRanges, ownedRange) => {
      if (!toRemove) {
        // All ranges removed already
        nextRanges.push(ownedRange)
      } else if (
        ownedRange.start.eq(toRemove.start) &&
        ownedRange.end.eq(toRemove.end) &&
        ownedRange.token.eq(toRemove.token)
      ) {
        // Remove this range
        toRemove = ranges.pop()
      } else if (
        ownedRange.start.lt(toRemove.start) &&
        ownedRange.end.gt(toRemove.end) &&
        ownedRange.token.eq(toRemove.token)
      ) {
        // This range contains the range to remove
        nextRanges = nextRanges.concat([
          createRange(ownedRange.token, ownedRange.start, toRemove.start),
          createRange(ownedRange.token, toRemove.end, ownedRange.end)
        ])
        toRemove = ranges.pop()
      } else if (
        ownedRange.start.eq(toRemove.start) &&
        ownedRange.end.gt(toRemove.end) &&
        ownedRange.token.eq(toRemove.token)
      ) {
        // Remove front of a range
        nextRanges.push(
          createRange(ownedRange.token, toRemove.end, ownedRange.end)
        )
        toRemove = ranges.pop()
      } else if (
        ownedRange.start.lt(toRemove.start) &&
        ownedRange.end.eq(toRemove.end) &&
        ownedRange.token.eq(toRemove.token)
      ) {
        // Remove end of a range
        nextRanges.push(
          createRange(ownedRange.token, ownedRange.start, toRemove.start)
        )
        toRemove = ranges.pop()
      } else {
        nextRanges.push(ownedRange)
      }
      return nextRanges
    }, [])

    return this._setRanges(address, nextRanges)
  }

  async _setRanges (address, ranges) {
    return this.services.db.set(`ranges:${address}`, ranges)
  }

  async _getRanges (address) {
    return this._castRanges(await this.services.db.get(`ranges:${address}`, []))
  }

  _castRanges (ranges) {
    return ranges.map(this._castRange.bind(this))
  }

  _castRange (range) {
    return {
      start: new BigNum(range.start, 'hex'),
      end: new BigNum(range.end, 'hex'),
      token: new BigNum(range.token, 'hex')
    }
  }
}

module.exports = RangeManagerService
