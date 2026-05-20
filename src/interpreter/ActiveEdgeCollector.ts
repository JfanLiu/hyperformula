/**
 * @license
 * Copyright (c) 2025 Handsoncode. All rights reserved.
 */

import {SimpleCellAddress} from '../Cell'
import {FormulaVertex} from '../DependencyGraph/FormulaVertex'

export type ActiveDependency =
  | {kind: 'CELL', address: SimpleCellAddress}
  | {kind: 'RANGE', start: SimpleCellAddress, end: SimpleCellAddress}
  | {kind: 'RANGE_CELL', start: SimpleCellAddress, end: SimpleCellAddress, address: SimpleCellAddress}
  | {kind: 'NAMED_EXPRESSION', expressionName: string, address: SimpleCellAddress}

export interface ActiveEdgeSnapshot {
  byFormula: Map<number, ActiveDependency[]>,
}

export class ActiveEdgeCollector {
  private readonly dependenciesByFormula = new Map<number, ActiveDependency[]>()

  public startFormulaEvaluation(from: FormulaVertex | undefined): void {
    if (from?.idInGraph === undefined) {
      return
    }

    this.dependenciesByFormula.delete(from.idInGraph)
  }

  public recordCellEdge(from: FormulaVertex | undefined, address: SimpleCellAddress): void {
    this.recordDependency(from, {kind: 'CELL', address})
  }

  public recordRangeEdge(from: FormulaVertex | undefined, start: SimpleCellAddress, end: SimpleCellAddress): void {
    this.recordDependency(from, {kind: 'RANGE', start, end})
  }

  public recordRangeCellEdge(from: FormulaVertex | undefined, start: SimpleCellAddress, end: SimpleCellAddress, address: SimpleCellAddress): void {
    this.recordDependency(from, {kind: 'RANGE_CELL', start, end, address})
  }

  public recordNamedExpressionEdge(from: FormulaVertex | undefined, expressionName: string, address: SimpleCellAddress): void {
    this.recordDependency(from, {kind: 'NAMED_EXPRESSION', expressionName, address})
  }

  public snapshot(): ActiveEdgeSnapshot {
    return {
      byFormula: new Map([...this.dependenciesByFormula.entries()].map(([formulaId, dependencies]) => [formulaId, [...dependencies]])),
    }
  }

  private recordDependency(from: FormulaVertex | undefined, dependency: ActiveDependency): void {
    if (from?.idInGraph === undefined) {
      return
    }

    const dependencies = this.dependenciesByFormula.get(from.idInGraph) ?? []
    if (!dependencies.some((existing) => ActiveEdgeCollector.sameDependency(existing, dependency))) {
      dependencies.push(dependency)
    }
    this.dependenciesByFormula.set(from.idInGraph, dependencies)
  }

  private static sameDependency(left: ActiveDependency, right: ActiveDependency): boolean {
    switch (left.kind) {
      case 'CELL':
        return right.kind === 'CELL'
          && left.address.sheet === right.address.sheet
          && left.address.col === right.address.col
          && left.address.row === right.address.row
      case 'RANGE':
        return right.kind === 'RANGE'
          && left.start.sheet === right.start.sheet
          && left.start.col === right.start.col
          && left.start.row === right.start.row
          && left.end.col === right.end.col
          && left.end.row === right.end.row
      case 'RANGE_CELL':
        return right.kind === 'RANGE_CELL'
          && left.start.sheet === right.start.sheet
          && left.start.col === right.start.col
          && left.start.row === right.start.row
          && left.end.col === right.end.col
          && left.end.row === right.end.row
          && left.address.sheet === right.address.sheet
          && left.address.col === right.address.col
          && left.address.row === right.address.row
      case 'NAMED_EXPRESSION':
        return right.kind === 'NAMED_EXPRESSION'
          && left.expressionName.toLowerCase() === right.expressionName.toLowerCase()
          && left.address.sheet === right.address.sheet
          && left.address.col === right.address.col
          && left.address.row === right.address.row
    }
  }
}
