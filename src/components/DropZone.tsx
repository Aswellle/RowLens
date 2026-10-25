/**
 * Application-wide drop target. Prevents the browser's default "open the
 * dropped file" navigation (PRD FR-01) and forwards the drop to a handler.
 * The overlay is pointer-events: none so the drop lands on the zone itself.
 */
import { useCallback, useRef, useState, type DragEvent, type ReactNode } from 'react';

type DropZoneProps = {
  onFilesDropped: (fileList: FileList) => void;
  children: ReactNode;
};

export function DropZone({ onFilesDropped, children }: DropZoneProps) {
  const [dragActive, setDragActive] = useState(false);
  // Counter so nested dragenter/leave pairs (child elements) don't flicker.
  const depthRef = useRef(0);

  const onDragEnter = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    depthRef.current += 1;
    setDragActive(true);
  }, []);

  const onDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    // Required to allow a drop and to stop the browser navigating to the file.
    event.preventDefault();
  }, []);

  const onDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    depthRef.current = Math.max(0, depthRef.current - 1);
    if (depthRef.current === 0) setDragActive(false);
  }, []);

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      depthRef.current = 0;
      setDragActive(false);
      if (event.dataTransfer?.files && event.dataTransfer.files.length > 0) {
        onFilesDropped(event.dataTransfer.files);
      }
    },
    [onFilesDropped],
  );

  return (
    <div
      className="app"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {children}
      {dragActive && <div className="drop-overlay">Drop to open</div>}
    </div>
  );
}
