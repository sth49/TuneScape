import { useState, useEffect, useRef, useCallback, useLayoutEffect } from 'react';

interface Size {
  width: number;
  height: number;
}

export function useContainerSize(): [React.RefCallback<HTMLDivElement>, Size] {
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  const elementRef = useRef<HTMLDivElement | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);

  const updateSize = useCallback(() => {
    if (elementRef.current) {
      const rect = elementRef.current.getBoundingClientRect();
      const newWidth = Math.floor(rect.width);
      const newHeight = Math.floor(rect.height);

      if (newWidth !== size.width || newHeight !== size.height) {
        setSize({ width: newWidth, height: newHeight });
      }
    }
  }, [size.width, size.height]);

  const ref = useCallback((node: HTMLDivElement | null) => {
    // Clean up previous observer
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }

    elementRef.current = node;

    if (node) {
      // Use ResizeObserver for continuous monitoring
      observerRef.current = new ResizeObserver(() => {
        const rect = node.getBoundingClientRect();
        setSize({
          width: Math.floor(rect.width),
          height: Math.floor(rect.height)
        });
      });
      observerRef.current.observe(node);

      // Initial measurement with a slight delay to ensure layout is complete
      requestAnimationFrame(() => {
        const rect = node.getBoundingClientRect();
        setSize({
          width: Math.floor(rect.width),
          height: Math.floor(rect.height)
        });
      });
    }
  }, []);

  // Also update on window resize
  useEffect(() => {
    const handleResize = () => {
      if (elementRef.current) {
        const rect = elementRef.current.getBoundingClientRect();
        setSize({
          width: Math.floor(rect.width),
          height: Math.floor(rect.height)
        });
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect();
      }
    };
  }, []);

  return [ref, size];
}
