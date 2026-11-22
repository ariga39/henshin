const textEncoder = new TextEncoder()

const compareUtf8 = (left: Uint8Array, right: Uint8Array): number => {
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }
  return left.length - right.length
}

const codePoints = (value: string): ReadonlyArray<number> =>
  Array.from(value, (char) => char.codePointAt(0) as number)

/** Orders page names without locale, normalization, or numeric overflow. */
export const compareNaturalPageNames = (left: string, right: string): number => {
  const leftPoints = codePoints(left)
  const rightPoints = codePoints(right)
  let leftIndex = 0
  let rightIndex = 0

  while (leftIndex < leftPoints.length && rightIndex < rightPoints.length) {
    const leftPoint = leftPoints[leftIndex]
    const rightPoint = rightPoints[rightIndex]
    const leftDigit = leftPoint >= 0x30 && leftPoint <= 0x39
    const rightDigit = rightPoint >= 0x30 && rightPoint <= 0x39

    if (leftDigit && rightDigit) {
      const leftStart = leftIndex
      const rightStart = rightIndex
      while (
        leftIndex < leftPoints.length &&
        leftPoints[leftIndex] >= 0x30 &&
        leftPoints[leftIndex] <= 0x39
      ) leftIndex += 1
      while (
        rightIndex < rightPoints.length &&
        rightPoints[rightIndex] >= 0x30 &&
        rightPoints[rightIndex] <= 0x39
      ) rightIndex += 1

      const leftDigits = leftPoints.slice(leftStart, leftIndex).map((point) => point - 0x30)
      const rightDigits = rightPoints.slice(rightStart, rightIndex).map((point) => point - 0x30)
      const leftNonZero = leftDigits.findIndex((digit) => digit !== 0)
      const rightNonZero = rightDigits.findIndex((digit) => digit !== 0)
      const leftSignificant = leftNonZero < 0 ? [0] : leftDigits.slice(leftNonZero)
      const rightSignificant = rightNonZero < 0 ? [0] : rightDigits.slice(rightNonZero)
      if (leftSignificant.length !== rightSignificant.length) {
        return leftSignificant.length - rightSignificant.length
      }
      for (let index = 0; index < leftSignificant.length; index += 1) {
        if (leftSignificant[index] !== rightSignificant[index]) {
          return leftSignificant[index] - rightSignificant[index]
        }
      }
      continue
    }

    if (leftPoint !== rightPoint) return leftPoint - rightPoint
    leftIndex += 1
    rightIndex += 1
  }

  if (leftIndex === leftPoints.length && rightIndex !== rightPoints.length) return -1
  if (rightIndex === rightPoints.length && leftIndex !== leftPoints.length) return 1
  return compareUtf8(textEncoder.encode(left), textEncoder.encode(right))
}
