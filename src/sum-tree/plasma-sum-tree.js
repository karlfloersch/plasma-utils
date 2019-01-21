const BigNum = require('bn.js')

const MerkleSumTree = require('./sum-tree')
const MerkleTreeNode = require('./merkle-tree-node')
const Transaction = require('../serialization').models.Transaction
const constants = require('../constants')

/**
 * Class that represents the special type of Merkle sum tree we use.
 * For more information, check out {@link https://plasma-core.readthedocs.io/en/latest/specs/sum-tree.html}
 */
class PlasmaMerkleSumTree extends MerkleSumTree {
  /**
   * Parses raw data into the set of leaf nodes.
   * @param {*} leaves List of raw leaves to be parsed.
   * @return {*} List of parsed leaf nodes.
   */
  parseLeaves (leaves) {
    // Pull out the start, end, and encoding of each transaction.
    leaves = leaves
      .reduce((prev, curr) => {
        let parsedTransfers = curr.transfers.map((transfer) => {
          return {
            start: new BigNum(transfer.decoded.start),
            end: new BigNum(transfer.decoded.end),
            encoded: '0x' + curr.encoded
          }
        })
        return prev.concat(parsedTransfers)
      }, [])
      .sort((a, b) => {
        return a.start - b.start
      })

    let parsed = []
    if (leaves.length === 1) {
      parsed.push(
        new MerkleTreeNode(
          PlasmaMerkleSumTree.hash(leaves[0].encoded),
          constants.MAX_COIN_ID
        )
      )
      return parsed
    }

    // For all leaves except the first and last,
    // sum at the leaves is defined as
    // start of the next leaf minus start of the current leaf.
    let curr, next, sum
    for (let i = 1; i < leaves.length - 1; i++) {
      curr = leaves[i]
      next = leaves[i + 1]
      sum = next.start.sub(curr.start)
      parsed.push(
        new MerkleTreeNode(PlasmaMerkleSumTree.hash(curr.encoded), sum)
      )
    }

    // Custom rule for the first leaf, if there's more than one.
    // Sum of the first leaf is always defined as
    // the start of its sibling transaction minus the minimum possible coin ID.
    // This is to allow for "implicit" non-inclusion proofs
    // for any ranges where `end` is less than `start` of the first transaction.
    parsed.unshift(
      new MerkleTreeNode(
        PlasmaMerkleSumTree.hash(leaves[0].encoded),
        leaves[1].start.sub(constants.MIN_COIN_ID)
      )
    )

    // Custom rule for the last leaf, if there's more than one.
    // Sum of the last leaf is always defined as
    // the maximum possible coin ID minus the start of the last transaction.
    // This is again to allow for "implicit" non-inclusion proofs
    // for any ranges where `start` is greater than `end`.
    parsed.push(
      new MerkleTreeNode(
        PlasmaMerkleSumTree.hash(leaves[leaves.length - 1].encoded),
        constants.MAX_COIN_ID.sub(leaves[leaves.length - 1].start)
      )
    )

    return parsed
  }

  /**
   * Returns an inclusion proof for the leaf at a given index.
   * @param {Number} index Index of the leaf to return a proof for.
   * @return {*} A list of sibling nodes that can be used to check inclusion of the node.
   */
  getInclusionProof (index) {
    if (index >= this.levels[0].length || index < 0) {
      throw new Error('Invalid leaf index')
    }

    let branch = []

    // User needs to be given this extra information.
    branch.push(
      new MerkleTreeNode(
        '0x0000000000000000000000000000000000000000000000000000000000000000',
        this.levels[0][index].sum
      ).data
    )

    let parentIndex
    let node
    let siblingIndex = index + (index % 2 === 0 ? 1 : -1)
    for (let i = 0; i < this.levels.length - 1; i++) {
      node = this.levels[i][siblingIndex]
      if (node === undefined) {
        node = PlasmaMerkleSumTree.emptyLeaf()
      }

      branch.push(node.data)

      // Figure out the parent and then figure out the parent's sibling.
      parentIndex = siblingIndex === 0 ? 0 : Math.floor(siblingIndex / 2)
      siblingIndex = parentIndex + (parentIndex % 2 === 0 ? 1 : -1)
    }

    return branch
  }

  /**
   * Checks whether a given transaction was included in a specific tree.
   * @param {Number} leafIndex Position of the transfer in the Merkle tree.
   * @param {Transaction} transaction A Transaction object.
   * @param {Number} transferIndex Which transfer to check.
   * @param {*} proof An inclusion proof.
   * @param {*} root The root node of the tree to check.
   * @return {boolean} `true` if the transaction is in the tree, `false` otherwise.
   */
  static checkInclusion (
    leafIndex,
    transaction,
    transferIndex,
    inclusionProof,
    root
  ) {
    const { valid } = PlasmaMerkleSumTree.checkInclusionAndGetBounds(
      leafIndex,
      transaction,
      transferIndex,
      inclusionProof,
      root
    )
    return valid
  }

  static checkInclusionAndGetBounds (
    leafIndex,
    transaction,
    transferIndex,
    inclusionProof,
    root
  ) {
    if (transaction instanceof String || typeof transaction === 'string') {
      transaction = new Transaction(transaction)
    }

    // Convert each element into a nicer object to work with.
    // Each proof element is a 48 byte (96 character) string.
    const proof = inclusionProof.map((element) => {
      return {
        hash: element.slice(0, 64),
        sum: new BigNum(element.slice(-32), 'hex')
      }
    })

    // Covert the index into a bitstring
    let path = new BigNum(leafIndex).toString(2, proof.length)

    // Reverse the order of the bitstring to start at the bottom of the tree
    path = path
      .split('')
      .reverse()
      .join('')

    let leftSum = new BigNum(0)
    let rightSum = new BigNum(0)
    let pathIndex = 0
    let proofElement
    let computedNode = new MerkleTreeNode(
      PlasmaMerkleSumTree.hash('0x' + transaction.encoded),
      proof[0].sum
    )
    for (let i = 1; i < proof.length; i++) {
      proofElement = new MerkleTreeNode(proof[i].hash, proof[i].sum)
      if (path[pathIndex] === '0') {
        computedNode = PlasmaMerkleSumTree.parent(computedNode, proofElement)
        rightSum.add(proof[i].sum)
      } else {
        computedNode = PlasmaMerkleSumTree.parent(proofElement, computedNode)
        leftSum.add(proof[i].sum)
      }
      pathIndex++
    }

    const transfer = transaction.transfers[transferIndex].decoded
    const validSum =
      transfer.start.gte(leftSum) &&
      transfer.end.lte(computedNode.sum.sub(rightSum))
    const validRoot = computedNode.data === root

    return {
      valid: validRoot && validSum,
      implicitStart: leftSum,
      implicitEnd: computedNode.sum.sub(rightSum)
    }
  }

  static checkNonInclusion (
    range,
    leafIndex,
    transaction,
    transferIndex,
    inclusionProof,
    root
  ) {
    const {
      valid,
      implicitStart,
      implicitEnd
    } = PlasmaMerkleSumTree.checkInclusionAndGetBounds(
      leafIndex,
      transaction,
      transferIndex,
      inclusionProof,
      root
    )

    return valid && range.start.gte(implicitStart) && range.end.lte(implicitEnd)
  }
}

module.exports = PlasmaMerkleSumTree
