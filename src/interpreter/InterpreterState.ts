/**
 * @license
 * Copyright (c) 2025 Handsoncode. All rights reserved.
 */

import {SimpleCellAddress} from '../Cell'
import {FormulaVertex} from '../DependencyGraph/FormulaVertex'
import {ActiveEdgeCollector} from './ActiveEdgeCollector'

export class InterpreterState {
  constructor(
    public formulaAddress: SimpleCellAddress,
    public arraysFlag: boolean,
    public formulaVertex?: FormulaVertex,
    public activeEdgeCollector?: ActiveEdgeCollector,
  ) {
  }
}
