import { useCallback, useEffect, useRef, useState } from "react";
import { createScene } from "./scene/createScene";
import TopBar from "./components/TopBar";
import Tooltip from "./components/Tooltip";
import DetailPanel from "./components/DetailPanel";
import FloorplateModal from "./components/FloorplateModal";
import { Hint, Legend, Toast, Loader } from "./components/Overlays";

export default function App() {
  const canvasRef = useRef(null);
  const sceneRef = useRef(null);
  const toastTimer = useRef(null);

  const [selected, setSelected] = useState(null);
  const [hover, setHover] = useState(null);
  const [planVisible, setPlanVisible] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!canvasRef.current) return undefined;

    let scene;
    try {
      scene = createScene(canvasRef.current, {
        onHover: setHover,
        onSelect: (data) => setSelected(data),
        onBackToOverview: () => {
          setSelected(null);
          setModalOpen(false);
        },
        onReady: () => setLoaded(true),
      });
      sceneRef.current = scene;
    } catch (err) {
      console.error("Failed to initialise the 3D scene", err);
      setLoaded(true);
      return undefined;
    }

    // The scene fades in shortly after the buildings finish growing.
    const t = setTimeout(() => setLoaded(true), 1200);

    return () => {
      clearTimeout(t);
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => () => clearTimeout(toastTimer.current), []);

  const showToast = useCallback((message) => {
    setToast(message);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 2600);
  }, []);

  const handleBack = useCallback(() => {
    sceneRef.current?.backToOverview();
    setSelected(null);
    setModalOpen(false);
  }, []);

  const handleTogglePlan = useCallback(() => {
    const visible = sceneRef.current?.togglePlan();
    setPlanVisible(Boolean(visible));
  }, []);

  // Escape closes the modal first, then returns to the overview.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      if (modalOpen) setModalOpen(false);
      else if (selected) handleBack();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [modalOpen, selected, handleBack]);

  return (
    <div className="stage">
      <canvas id="c" ref={canvasRef} aria-label="Interactive 3D model of Masdar City Square" />

      <TopBar
        planVisible={planVisible}
        onTogglePlan={handleTogglePlan}
        showReset={Boolean(selected)}
        onReset={handleBack}
      />

      <Tooltip hover={selected ? null : hover} />
      <Hint hidden={Boolean(selected)} />
      <Legend hidden={Boolean(selected)} />

      <DetailPanel
        building={selected}
        onBack={handleBack}
        onFloorplates={() => setModalOpen(true)}
        onEnquire={() => showToast("Leasing enquiry started — a broker will be in touch")}
      />

      <FloorplateModal
        building={selected}
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
      />

      <Toast message={toast} />
      <Loader gone={loaded} />
    </div>
  );
}
