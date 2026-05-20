/**
 * @license
 * Copyright (c) 2025 Handsoncode. All rights reserved.
 */

import {AbsoluteCellRange} from './AbsoluteCellRange'
import {absolutizeDependencies} from './absolutizeDependencies'
import {CellError, ErrorType, SimpleCellAddress} from './Cell'
import {Config} from './Config'
import {ContentChanges} from './ContentChanges'
import {ArrayFormulaVertex, DependencyGraph, RangeVertex, Vertex} from './DependencyGraph'
import {FormulaVertex} from './DependencyGraph/FormulaVertex'
import {TopSortResult} from './DependencyGraph/TopSort'
import {ActiveDependency, ActiveEdgeCollector} from './interpreter/ActiveEdgeCollector'
import {Interpreter} from './interpreter/Interpreter'
import {InterpreterState} from './interpreter/InterpreterState'
import {EmptyValue, getRawValue, InterpreterValue} from './interpreter/InterpreterValue'
import {SimpleRangeValue} from './SimpleRangeValue'
import {LazilyTransformingAstService} from './LazilyTransformingAstService'
import {ColumnSearchStrategy} from './Lookup/SearchStrategy'
import {Ast, RelativeDependency} from './parser'
import {Statistics, StatType} from './statistics'

export class Evaluator {
  private activeEdgeCollector?: ActiveEdgeCollector

  constructor(
    private readonly config: Config,
    private readonly stats: Statistics,
    public readonly interpreter: Interpreter,
    private readonly lazilyTransformingAstService: LazilyTransformingAstService,
    private readonly dependencyGraph: DependencyGraph,
    private readonly columnSearch: ColumnSearchStrategy,
  ) {
  }

  public run(): void {
    this.activeEdgeCollector = new ActiveEdgeCollector()
    try {
      this.stats.start(StatType.TOP_SORT)
      const topSortResult = this.dependencyGraph.topSortWithScc()
      this.stats.end(StatType.TOP_SORT)

      this.stats.measure(StatType.EVALUATION, () => {
        this.recomputeFormulas(topSortResult)
      })
    } finally {
      this.activeEdgeCollector = undefined
    }
  }

  public partialRun(vertices: Vertex[]): ContentChanges {
    this.activeEdgeCollector = new ActiveEdgeCollector()
    const changes = ContentChanges.empty()

    try {
      this.stats.measure(StatType.EVALUATION, () => {
        const deferredFromSorted: FormulaVertex[] = []
        const topSortResult = this.dependencyGraph.graph.getTopSortedWithSccSubgraphFrom(
          vertices,
          (vertex: Vertex) => this.recomputeSortedVertex(vertex, changes, deferredFromSorted),
          (vertex: Vertex) => {
            if (vertex instanceof RangeVertex) {
              vertex.clearCache()
            }
          },
        )
        this.resolveCyclicSccs(topSortResult.cycled, topSortResult.cyclicSccs, changes)
        this.recomputeDeferredFromSorted(deferredFromSorted, changes)
      })
    } finally {
      this.activeEdgeCollector = undefined
    }
    return changes
  }

  public runAndForget(ast: Ast, address: SimpleCellAddress, dependencies: RelativeDependency[]): InterpreterValue {
    const tmpRanges: RangeVertex[] = []
    for (const dep of absolutizeDependencies(dependencies, address)) {
      if (dep instanceof AbsoluteCellRange) {
        const range = dep
        if (this.dependencyGraph.getRange(range.start, range.end) === undefined) {
          const rangeVertex = new RangeVertex(range)
          this.dependencyGraph.rangeMapping.addOrUpdateVertex(rangeVertex)
          tmpRanges.push(rangeVertex)
        }
      }
    }
    const ret = this.evaluateAstToCellValue(ast, new InterpreterState(address, this.config.useArrayArithmetic))

    tmpRanges.forEach((rangeVertex) => {
      this.dependencyGraph.rangeMapping.removeVertexIfExists(rangeVertex)
    })

    return ret
  }

  /**
   * Recalculates the value of a single vertex assuming its dependencies have already been recalculated
   */
  private recomputeVertex(vertex: Vertex, changes: ContentChanges): boolean {
    if (vertex instanceof FormulaVertex) {
      const currentValue = vertex.isComputed() ? vertex.getCellValue() : undefined
      const newCellValue = this.recomputeFormulaVertexValue(vertex)
      if (newCellValue !== currentValue) {
        const address = vertex.getAddress(this.lazilyTransformingAstService)
        changes.addChange(newCellValue, address)
        this.columnSearch.change(getRawValue(currentValue), getRawValue(newCellValue), address)
        return true
      }
      return false
    } else if (vertex instanceof RangeVertex) {
      vertex.clearCache()
      return true
    } else {
      return true
    }
  }

  private recomputeSortedVertex(vertex: Vertex, changes: ContentChanges, deferredFromSorted: FormulaVertex[]): boolean {
    try {
      return this.recomputeVertex(vertex, changes)
    } catch (e) {
      if (!(vertex instanceof FormulaVertex) || !this.shouldDeferSortedVertex(e)) {
        throw e
      }
      deferredFromSorted.push(vertex)
      return true
    }
  }

  private recomputeDeferredFromSorted(deferredFromSorted: FormulaVertex[], changes?: ContentChanges): void {
    deferredFromSorted.forEach((vertex) => {
      try {
        if (changes !== undefined) {
          this.recomputeVertex(vertex, changes)
        } else {
          const newCellValue = this.recomputeFormulaVertexValue(vertex)
          const address = vertex.getAddress(this.lazilyTransformingAstService)
          this.columnSearch.add(getRawValue(newCellValue), address)
        }
      } catch (e) {
        if (!this.shouldDeferSortedVertex(e)) {
          throw e
        }
        if (changes !== undefined) {
          this.processVertexOnCycle(vertex, changes)
        } else {
          vertex.setCellValue(new CellError(ErrorType.CYCLE, undefined, vertex))
        }
      }
    })
  }

  private shouldDeferSortedVertex(error: unknown): boolean {
    return error instanceof Error && error.message === 'Value of the formula cell is not computed.'
  }

  /**
   * Processes a vertex that is part of a cycle in dependency graph
   */
  private processVertexOnCycle(vertex: Vertex, changes: ContentChanges, previousValue?: InterpreterValue): void {
    if (vertex instanceof RangeVertex) {
      vertex.clearCache()
    } else if (vertex instanceof FormulaVertex) {
      const address = vertex.getAddress(this.lazilyTransformingAstService)
      this.columnSearch.remove(getRawValue(previousValue ?? vertex.valueOrUndef()), address)
      const error = new CellError(ErrorType.CYCLE, undefined, vertex)
      vertex.setCellValue(error)
      changes.addChange(error, address)
    }
  }

  /**
   * Recalculates formulas in the topological sort order
   */
  private recomputeFormulas(topSortResult: TopSortResult<Vertex>): void {
    const {sorted, cycled, cyclicSccs} = topSortResult
    const deferredFromSorted: FormulaVertex[] = []
    sorted.forEach((vertex: Vertex) => {
      if (vertex instanceof FormulaVertex) {
        try {
          const newCellValue = this.recomputeFormulaVertexValue(vertex)
          const address = vertex.getAddress(this.lazilyTransformingAstService)
          this.columnSearch.add(getRawValue(newCellValue), address)
        } catch (e) {
          if (!this.shouldDeferSortedVertex(e)) {
            throw e
          }
          deferredFromSorted.push(vertex)
        }
      } else if (vertex instanceof RangeVertex) {
        vertex.clearCache()
      }
    })

    this.resolveCyclicSccs(cycled, cyclicSccs)
    this.recomputeDeferredFromSorted(deferredFromSorted)
  }

  private resolveCyclicSccs(cycled: Vertex[], cyclicSccs: Vertex[][], changes?: ContentChanges): void {
    const remainingCycledFormulas = new Set<FormulaVertex>(cycled.filter((vertex): vertex is FormulaVertex => vertex instanceof FormulaVertex))
    const previousValues = new Map<FormulaVertex, InterpreterValue | undefined>()

    for (const scc of cyclicSccs) {
      const sccFormulaVertices = scc.filter((vertex): vertex is FormulaVertex => vertex instanceof FormulaVertex)
      if (changes !== undefined) {
        sccFormulaVertices.forEach((vertex) => previousValues.set(vertex, vertex.valueOrUndef()))
      }

      if (sccFormulaVertices.length === 0) {
        scc.forEach((vertex) => {
          if (vertex instanceof RangeVertex) {
            vertex.clearCache()
          }
        })
        continue
      }

      scc.forEach((vertex) => {
        if (vertex instanceof RangeVertex) {
          vertex.clearCache()
        }
      })

      const unresolvedAfterProbe = new Set<FormulaVertex>(sccFormulaVertices)
      let madeProgress = true
      while (madeProgress && unresolvedAfterProbe.size > 0) {
        madeProgress = false
        for (const vertex of [...unresolvedAfterProbe]) {
          try {
            this.recomputeFormulaVertexValue(vertex)
            unresolvedAfterProbe.delete(vertex)
            madeProgress = true
          } catch (e) {
            // Best effort: another vertex in the SCC may become computable first.
          }
        }
      }

      const forceUnresolved = new Set<number>()
      unresolvedAfterProbe.forEach((vertex) => {
        if (vertex.idInGraph !== undefined) {
          forceUnresolved.add(vertex.idInGraph)
        }
      })

      const [acyclicOrder, unresolved] = this.resolveOrderFromActiveEdges(sccFormulaVertices, forceUnresolved)

      acyclicOrder.forEach((vertex) => {
        try {
          if (changes !== undefined) {
            this.recomputeCyclicVertex(vertex, changes, previousValues.get(vertex))
          } else {
            const newCellValue = this.recomputeFormulaVertexValue(vertex)
            const address = vertex.getAddress(this.lazilyTransformingAstService)
            this.columnSearch.add(getRawValue(newCellValue), address)
          }
          remainingCycledFormulas.delete(vertex)
        } catch (e) {
          remainingCycledFormulas.add(vertex)
        }
      })

      unresolved.forEach((vertex) => {
        remainingCycledFormulas.add(vertex)
      })
    }

    remainingCycledFormulas.forEach((vertex) => {
      if (changes !== undefined) {
        this.processVertexOnCycle(vertex, changes, previousValues.get(vertex))
      } else {
        vertex.setCellValue(new CellError(ErrorType.CYCLE, undefined, vertex))
      }
    })
  }

  private resolveOrderFromActiveEdges(sccFormulaVertices: FormulaVertex[], forceUnresolved: Set<number>): [FormulaVertex[], FormulaVertex[]] {
    const idToVertex = new Map<number, FormulaVertex>()
    sccFormulaVertices.forEach((vertex) => {
      if (vertex.idInGraph !== undefined) {
        idToVertex.set(vertex.idInGraph, vertex)
      }
    })

    const incoming = new Map<number, Set<number>>()
    const outgoing = new Map<number, Set<number>>()
    idToVertex.forEach((_, vertexId) => {
      incoming.set(vertexId, new Set())
      outgoing.set(vertexId, new Set())
    })

    const snapshot = this.activeEdgeCollector?.snapshot()
    if (snapshot !== undefined) {
      for (const [formulaId, deps] of snapshot.byFormula.entries()) {
        if (!idToVertex.has(formulaId)) {
          continue
        }
        const dependencies = this.resolveDependenciesWithinScc(deps, idToVertex)
        for (const dependencyFormulaId of dependencies) {
          incoming.get(formulaId)?.add(dependencyFormulaId)
          outgoing.get(dependencyFormulaId)?.add(formulaId)
        }
      }
    }

    const queue: number[] = []
    incoming.forEach((deps, nodeId) => {
      if (deps.size === 0 && !forceUnresolved.has(nodeId)) {
        queue.push(nodeId)
      }
    })

    const ordered: FormulaVertex[] = []
    const processed = new Set<number>()
    while (queue.length > 0) {
      const nodeId = queue.shift()!
      if (processed.has(nodeId)) {
        continue
      }
      processed.add(nodeId)

      const vertex = idToVertex.get(nodeId)
      if (vertex !== undefined) {
        ordered.push(vertex)
      }

      outgoing.get(nodeId)?.forEach((nextNodeId) => {
        const nextIncoming = incoming.get(nextNodeId)
        if (nextIncoming === undefined) {
          return
        }
        nextIncoming.delete(nodeId)
        if (nextIncoming.size === 0 && !forceUnresolved.has(nextNodeId)) {
          queue.push(nextNodeId)
        }
      })
    }

    const unresolved = sccFormulaVertices.filter((vertex) => {
      if (vertex.idInGraph === undefined) {
        return true
      }
      return forceUnresolved.has(vertex.idInGraph) || !processed.has(vertex.idInGraph)
    })

    return [ordered, unresolved]
  }

  private resolveDependenciesWithinScc(dependencies: ActiveDependency[], idToVertex: Map<number, FormulaVertex>): Set<number> {
    const dependencyIds = new Set<number>()
    const rangesWithPreciseDependencies = new Set<string>()

    dependencies.forEach((dependency) => {
      if (dependency.kind === 'RANGE_CELL' || dependency.kind === 'RANGE_EMPTY') {
        rangesWithPreciseDependencies.add(this.rangeDependencyKey(dependency.start, dependency.end))
      }
    })

    dependencies.forEach((dependency) => {
      if (dependency.kind === 'CELL' || dependency.kind === 'NAMED_EXPRESSION' || dependency.kind === 'RANGE_CELL') {
        const vertex = this.dependencyGraph.getCell(dependency.address)
        if (vertex instanceof FormulaVertex && vertex.idInGraph !== undefined && idToVertex.has(vertex.idInGraph)) {
          dependencyIds.add(vertex.idInGraph)
        }
      } else {
        if (rangesWithPreciseDependencies.has(this.rangeDependencyKey(dependency.start, dependency.end))) {
          return
        }
        for (const [vertexId, formulaVertex] of idToVertex.entries()) {
          const address = formulaVertex.getAddress(this.lazilyTransformingAstService)
          if (address.sheet === dependency.start.sheet
            && address.col >= dependency.start.col && address.col <= dependency.end.col
            && address.row >= dependency.start.row && address.row <= dependency.end.row) {
            dependencyIds.add(vertexId)
          }
        }
      }
    })

    return dependencyIds
  }

  private rangeDependencyKey(start: SimpleCellAddress, end: SimpleCellAddress): string {
    return `${start.sheet}:${start.col}:${start.row}:${end.col}:${end.row}`
  }

  private recomputeCyclicVertex(vertex: FormulaVertex, changes: ContentChanges, previousValue: InterpreterValue | undefined): void {
    const newCellValue = this.recomputeFormulaVertexValue(vertex)
    if (newCellValue !== previousValue) {
      const address = vertex.getAddress(this.lazilyTransformingAstService)
      changes.addChange(newCellValue, address)
      this.columnSearch.change(getRawValue(previousValue), getRawValue(newCellValue), address)
    }
  }

  private recomputeFormulaVertexValue(vertex: FormulaVertex): InterpreterValue {
    this.activeEdgeCollector?.startFormulaEvaluation(vertex)
    const address = vertex.getAddress(this.lazilyTransformingAstService)
    if (vertex instanceof ArrayFormulaVertex && (vertex.array.size.isRef || !this.dependencyGraph.isThereSpaceForArray(vertex))) {
      return vertex.setNoSpace()
    } else {
      const formula = vertex.getFormula(this.lazilyTransformingAstService)
      const newCellValue = this.evaluateAstToCellValue(formula, new InterpreterState(address, this.config.useArrayArithmetic, vertex, this.activeEdgeCollector))
      return vertex.setCellValue(newCellValue)
    }
  }

  private evaluateAstToCellValue(ast: Ast, state: InterpreterState): InterpreterValue {
    const interpreterValue = this.interpreter.evaluateAst(ast, state)
    if (interpreterValue instanceof SimpleRangeValue) {
      return interpreterValue
    } else if (interpreterValue === EmptyValue && this.config.evaluateNullToZero) {
      return 0
    } else {
      return interpreterValue
    }
  }
}
