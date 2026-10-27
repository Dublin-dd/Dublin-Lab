/** Keep conversation backgrounds on the workbench image canvas. */
import { useLayoutEffect, type RefObject } from 'react'

/** Align a clipped image with its outer canvas without changing either opacity. */
export function useDublinBackgroundAlignment(
  canvas: RefObject<HTMLElement | null>,
  image: RefObject<HTMLImageElement | null>,
  active: boolean,
): void {
  useLayoutEffect(() => {
    const outer = canvas.current
    const layer = image.current
    const region = layer?.parentElement
    if (outer === null || layer === null || region === undefined || region === null) return
    if (!active) { layer.style.visibility = 'hidden'; return }
    const align = (): void => {
      const canvasBox = outer.getBoundingClientRect()
      const regionBox = region.getBoundingClientRect()
      if (canvasBox.width <= 0 || canvasBox.height <= 0 || regionBox.width <= 0 || regionBox.height <= 0) {
        layer.style.visibility = 'hidden'
        return
      }
      // Both images cover the same full canvas; the conversation only clips it.
      layer.style.width = `${canvasBox.width}px`
      layer.style.height = `${canvasBox.height}px`
      layer.style.left = `${canvasBox.left - regionBox.left}px`
      layer.style.top = `${canvasBox.top - regionBox.top}px`
      layer.style.visibility = 'visible'
    }
    align()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(align)
    observer?.observe(outer)
    observer?.observe(region)
    window.addEventListener('resize', align)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', align)
      layer.style.visibility = 'hidden'
    }
  }, [canvas, image, active])
}
