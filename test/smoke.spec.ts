import {DetailedCellError, ErrorType, HyperFormula} from '../src'
import {SimpleCellAddress, simpleCellAddress} from '../src/Cell'

const adr = (stringAddress: string, sheet: number = 0): SimpleCellAddress => {

  const result = /^(\$([A-Za-z0-9_]+)\.)?(\$?)([A-Za-z]+)(\$?)([0-9]+)$/.exec(stringAddress)!
  const row = Number(result[6]) - 1
  return simpleCellAddress(sheet, colNumber(result[4]), row)
}

const colNumber = (input: string): number => {
  if (input.length === 1) {
    return input.toUpperCase().charCodeAt(0) - 65
  } else {
    return input.split('').reduce((currentColumn, nextLetter) => {
      return currentColumn * 26 + (nextLetter.toUpperCase().charCodeAt(0) - 64)
    }, 0) - 1
  }
}

const expectCycle = (value: unknown): void => {
  expect(value).toBeInstanceOf(DetailedCellError)
  expect((value as DetailedCellError).type).toBe(ErrorType.CYCLE)
}

describe('HyperFormula', () => {
  it('should build engine from array and evaluate formulas', () => {
    const data = [
      [1, 2, 3],
      [4, 5, 6],
      ['=SUM(A1:C1)', '=SUM(A2:C2)', '=SUM(A1:C2)'],
    ]

    const hf = HyperFormula.buildFromArray(data, {licenseKey: 'gpl-v3'})

    expect(hf.getCellValue(adr('A3'))).toBe(6)
    expect(hf.getCellValue(adr('B3'))).toBe(15)
    expect(hf.getCellValue(adr('C3'))).toBe(21)
    expect(hf.getSheetDimensions(0)).toEqual({width: 3, height: 3})

    hf.destroy()
  })

  it('should evaluate arithmetic and logical formulas', () => {
    const data = [
      [10, 20, 30],
      ['=A1+B1+C1', '=A1*B1', '=C1/A1'],
      ['=IF(A1>5, "big", "small")', '=AND(A1>0, B1>0)', '=OR(A1<0, B1>0)'],
    ]

    const hf = HyperFormula.buildFromArray(data, {licenseKey: 'gpl-v3'})

    expect(hf.getCellValue(adr('A2'))).toBe(60)
    expect(hf.getCellValue(adr('B2'))).toBe(200)
    expect(hf.getCellValue(adr('C2'))).toBe(3)

    expect(hf.getCellValue(adr('A3'))).toBe('big')
    expect(hf.getCellValue(adr('B3'))).toBe(true)
    expect(hf.getCellValue(adr('C3'))).toBe(true)

    hf.destroy()
  })

  it('should handle common spreadsheet functions', () => {
    const data = [
      [1, 2, 3, 4, 5],
      ['=SUM(A1:E1)', '=AVERAGE(A1:E1)', '=MIN(A1:E1)', '=MAX(A1:E1)', '=COUNT(A1:E1)'],
      ['=CONCATENATE("Hello", " ", "World")', '=LEN("Test")', '=UPPER("hello")', '=LOWER("HELLO")', '=ABS(-5)'],
    ]

    const hf = HyperFormula.buildFromArray(data, {licenseKey: 'gpl-v3'})

    expect(hf.getCellValue(adr('A2'))).toBe(15)
    expect(hf.getCellValue(adr('B2'))).toBe(3)
    expect(hf.getCellValue(adr('C2'))).toBe(1)
    expect(hf.getCellValue(adr('D2'))).toBe(5)
    expect(hf.getCellValue(adr('E2'))).toBe(5)

    expect(hf.getCellValue(adr('A3'))).toBe('Hello World')
    expect(hf.getCellValue(adr('B3'))).toBe(4)
    expect(hf.getCellValue(adr('C3'))).toBe('HELLO')
    expect(hf.getCellValue(adr('D3'))).toBe('hello')
    expect(hf.getCellValue(adr('E3'))).toBe(5)

    hf.destroy()
  })

  it('should add and remove rows with formula updates', () => {
    const data = [
      [1],
      [2],
      [3],
      ['=SUM(A1:A3)'],
    ]

    const hf = HyperFormula.buildFromArray(data, {licenseKey: 'gpl-v3'})

    expect(hf.getCellValue(adr('A4'))).toBe(6)

    hf.addRows(0, [1, 1])
    hf.setCellContents(adr('A2'), 10)

    expect(hf.getCellValue(adr('A5'))).toBe(16)

    hf.removeRows(0, [1, 1])

    expect(hf.getCellValue(adr('A4'))).toBe(6)

    hf.destroy()
  })

  it('should resolve cycles guarded by inactive IF branches', () => {
    const hf = HyperFormula.buildFromArray([
      ['=IF(FALSE(),B1,1)', '=A1+1', '=A1+1'],
    ], {licenseKey: 'gpl-v3'})

    expect(hf.getCellValue(adr('A1'))).toBe(1)
    expect(hf.getCellValue(adr('B1'))).toBe(2)
    expect(hf.getCellValue(adr('C1'))).toBe(2)

    const cycleChanges = hf.setCellContents(adr('A1'), '=IF(TRUE(),B1,1)')

    expectCycle(hf.getCellValue(adr('A1')))
    expectCycle(hf.getCellValue(adr('B1')))
    expectCycle(hf.getCellValue(adr('C1')))
    expect(cycleChanges.length).toBe(3)

    const resolvedChanges = hf.setCellContents(adr('A1'), '=IF(FALSE(),B1,1)')

    expect(hf.getCellValue(adr('A1'))).toBe(1)
    expect(hf.getCellValue(adr('B1'))).toBe(2)
    expect(hf.getCellValue(adr('C1'))).toBe(2)
    expect(resolvedChanges.map(change => change.newValue)).toEqual([1, 2, 2])

    hf.destroy()
  })

  it('should resolve cycles guarded by inactive CHOOSE options', () => {
    const hf = HyperFormula.buildFromArray([
      ['=CHOOSE(1,1,B1)', '=A1+1'],
    ], {licenseKey: 'gpl-v3'})

    expect(hf.getCellValue(adr('A1'))).toBe(1)
    expect(hf.getCellValue(adr('B1'))).toBe(2)

    const cycleChanges = hf.setCellContents(adr('A1'), '=CHOOSE(2,1,B1)')

    expectCycle(hf.getCellValue(adr('A1')))
    expectCycle(hf.getCellValue(adr('B1')))
    expect(cycleChanges.length).toBe(2)

    const resolvedChanges = hf.setCellContents(adr('A1'), '=CHOOSE(1,1,B1)')

    expect(hf.getCellValue(adr('A1'))).toBe(1)
    expect(hf.getCellValue(adr('B1'))).toBe(2)
    expect(resolvedChanges.map(change => change.newValue)).toEqual([1, 2])

    hf.destroy()
  })

  it('should resolve cycles guarded by inactive SWITCH branches', () => {
    const hf = HyperFormula.buildFromArray([
      ['=SWITCH(1,1,1,2,B1)', '=A1+1'],
    ], {licenseKey: 'gpl-v3'})

    expect(hf.getCellValue(adr('A1'))).toBe(1)
    expect(hf.getCellValue(adr('B1'))).toBe(2)

    const cycleChanges = hf.setCellContents(adr('A1'), '=SWITCH(2,1,1,2,B1)')

    expectCycle(hf.getCellValue(adr('A1')))
    expectCycle(hf.getCellValue(adr('B1')))
    expect(cycleChanges.length).toBe(2)

    const resolvedChanges = hf.setCellContents(adr('A1'), '=SWITCH(1,1,1,2,B1)')

    expect(hf.getCellValue(adr('A1'))).toBe(1)
    expect(hf.getCellValue(adr('B1'))).toBe(2)
    expect(resolvedChanges.map(change => change.newValue)).toEqual([1, 2])

    hf.destroy()
  })

  it('should resolve cycles guarded by inactive IFERROR fallback branches', () => {
    const hf = HyperFormula.buildFromArray([
      ['=IFERROR(1,B1)', '=A1+1'],
    ], {licenseKey: 'gpl-v3'})

    expect(hf.getCellValue(adr('A1'))).toBe(1)
    expect(hf.getCellValue(adr('B1'))).toBe(2)

    const cycleChanges = hf.setCellContents(adr('A1'), '=IFERROR(1/0,B1)')

    expectCycle(hf.getCellValue(adr('A1')))
    expectCycle(hf.getCellValue(adr('B1')))
    expect(cycleChanges.length).toBe(2)

    const resolvedChanges = hf.setCellContents(adr('A1'), '=IFERROR(1,B1)')

    expect(hf.getCellValue(adr('A1'))).toBe(1)
    expect(hf.getCellValue(adr('B1'))).toBe(2)
    expect(resolvedChanges.map(change => change.newValue)).toEqual([1, 2])

    hf.destroy()
  })

  it('should resolve cycles guarded by inactive IFNA fallback branches', () => {
    const hf = HyperFormula.buildFromArray([
      ['=IFNA(1,B1)', '=A1+1'],
    ], {licenseKey: 'gpl-v3'})

    expect(hf.getCellValue(adr('A1'))).toBe(1)
    expect(hf.getCellValue(adr('B1'))).toBe(2)

    const cycleChanges = hf.setCellContents(adr('A1'), '=IFNA(NA(),B1)')

    expectCycle(hf.getCellValue(adr('A1')))
    expectCycle(hf.getCellValue(adr('B1')))
    expect(cycleChanges.length).toBe(2)

    const resolvedChanges = hf.setCellContents(adr('A1'), '=IFNA(1,B1)')

    expect(hf.getCellValue(adr('A1'))).toBe(1)
    expect(hf.getCellValue(adr('B1'))).toBe(2)
    expect(resolvedChanges.map(change => change.newValue)).toEqual([1, 2])

    hf.destroy()
  })

  it('should resolve exact lookup cycles from unused table entries', () => {
    const vlookupHf = HyperFormula.buildFromArray([
      ['=VLOOKUP(1,A3:B4,2,FALSE())'],
      [null],
      [1, 10],
      [2, '=A1+1'],
    ], {licenseKey: 'gpl-v3'})

    expect(vlookupHf.getCellValue(adr('A1'))).toBe(10)
    expect(vlookupHf.getCellValue(adr('B4'))).toBe(11)

    vlookupHf.setCellContents(adr('A1'), '=VLOOKUP(2,A3:B4,2,FALSE())')

    expectCycle(vlookupHf.getCellValue(adr('A1')))
    expectCycle(vlookupHf.getCellValue(adr('B4')))

    vlookupHf.setCellContents(adr('A1'), '=VLOOKUP(1,A3:B4,2,FALSE())')

    expect(vlookupHf.getCellValue(adr('A1'))).toBe(10)
    expect(vlookupHf.getCellValue(adr('B4'))).toBe(11)

    vlookupHf.destroy()

    const hlookupHf = HyperFormula.buildFromArray([
      [1, 2],
      [10, '=A3+1'],
      ['=HLOOKUP(1,A1:B2,2,FALSE())'],
    ], {licenseKey: 'gpl-v3'})

    expect(hlookupHf.getCellValue(adr('A3'))).toBe(10)
    expect(hlookupHf.getCellValue(adr('B2'))).toBe(11)

    hlookupHf.setCellContents(adr('A3'), '=HLOOKUP(2,A1:B2,2,FALSE())')

    expectCycle(hlookupHf.getCellValue(adr('A3')))
    expectCycle(hlookupHf.getCellValue(adr('B2')))

    hlookupHf.destroy()
  })

  it('should resolve XLOOKUP cycles from unused return array entries', () => {
    const verticalHf = HyperFormula.buildFromArray([
      ['=XLOOKUP(1,A3:A4,B3:B4)'],
      [null],
      [1, 10],
      [2, '=A1+1'],
    ], {licenseKey: 'gpl-v3'})

    expect(verticalHf.getCellValue(adr('A1'))).toBe(10)
    expect(verticalHf.getCellValue(adr('B4'))).toBe(11)

    verticalHf.setCellContents(adr('A1'), '=XLOOKUP(2,A3:A4,B3:B4)')

    expectCycle(verticalHf.getCellValue(adr('A1')))
    expectCycle(verticalHf.getCellValue(adr('B4')))

    verticalHf.destroy()

    const horizontalHf = HyperFormula.buildFromArray([
      [null, null, 1, 2],
      ['=XLOOKUP(1,C1:D1,C2:D2)', null, 10, '=A2+1'],
    ], {licenseKey: 'gpl-v3'})

    expect(horizontalHf.getCellValue(adr('A2'))).toBe(10)
    expect(horizontalHf.getCellValue(adr('D2'))).toBe(11)

    horizontalHf.setCellContents(adr('A2'), '=XLOOKUP(2,C1:D1,C2:D2)')

    expectCycle(horizontalHf.getCellValue(adr('A2')))
    expectCycle(horizontalHf.getCellValue(adr('D2')))

    horizontalHf.destroy()
  })

  it('should resolve exact MATCH cycles from cells after the first match', () => {
    const verticalHf = HyperFormula.buildFromArray([
      ['=MATCH(1,A3:A4,0)'],
      [null],
      [1],
      ['=A1+1'],
    ], {licenseKey: 'gpl-v3'})

    expect(verticalHf.getCellValue(adr('A1'))).toBe(1)
    expect(verticalHf.getCellValue(adr('A4'))).toBe(2)

    verticalHf.destroy()

    const horizontalHf = HyperFormula.buildFromArray([
      [null, null, 1, '=A2+1'],
      ['=MATCH(1,C1:D1,0)'],
    ], {licenseKey: 'gpl-v3'})

    expect(horizontalHf.getCellValue(adr('A2'))).toBe(1)
    expect(horizontalHf.getCellValue(adr('D1'))).toBe(2)

    horizontalHf.destroy()
  })
})
