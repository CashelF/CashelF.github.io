import React, { useEffect, useRef } from 'react';

const INITIAL_NODES = 12;
const MAX_NODES = 64;
const CONNECTION_DISTANCE = 360;
const POINTER_DISTANCE = 200;
const INTERACTIVE_TARGETS = [
  'a', 'button', 'input', 'textarea', 'select', 'label', 'summary',
  'audio', 'video', '[role="button"]', '[role="link"]', '[role="slider"]',
  '[contenteditable="true"]', '.site-robot', '.brain-console',
  '[data-network-ignore]'
].join(', ');

function isInteractiveTarget(target) {
  const element = target && (target.nodeType === 1 ? target : target.parentElement);
  return Boolean(element && element.closest && element.closest(INTERACTIVE_TARGETS));
}

class Node {
  constructor(x, y) {
    this.x = x;
    this.y = y;
    this.vx = (Math.random() - 0.5) * 0.8;
    this.vy = (Math.random() - 0.5) * 0.8;
    this.radius = 2 + Math.random() * 2;
  }

  update(delta, width, height) {
    this.x += this.vx * delta;
    this.y += this.vy * delta;
    if (this.x < 0 || this.x > width) this.vx *= -1;
    if (this.y < 0 || this.y > height) this.vy *= -1;
    this.x = Math.max(0, Math.min(width, this.x));
    this.y = Math.max(0, Math.min(height, this.y));
  }
}

export default function NeuralNetworkBackground({ theme = 'light' }) {
  const canvasRef = useRef(null);
  const themeRef = useRef(theme);
  const redrawRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    let ctx;
    try {
      ctx = canvas.getContext('2d');
    } catch (error) {
      return undefined;
    }
    if (!ctx) return undefined;

    const nodes = [];
    const pointer = { x: null, y: null };
    const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
    let reducedMotion = motionPreference.matches;
    let width = 0;
    let height = 0;
    let animation = null;
    let previousTime = null;
    let disposed = false;

    const draw = () => {
      const color = themeRef.current === 'dark' ? '148, 163, 184' : '108, 122, 98';
      ctx.clearRect(0, 0, width, height);

      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const other = nodes[j];
          const distance = Math.hypot(node.x - other.x, node.y - other.y);
          if (distance >= CONNECTION_DISTANCE) continue;
          ctx.beginPath();
          ctx.moveTo(node.x, node.y);
          ctx.lineTo(other.x, other.y);
          ctx.strokeStyle = `rgba(${color}, ${(1 - distance / CONNECTION_DISTANCE) * 0.32})`;
          ctx.lineWidth = 1;
          ctx.stroke();
        }

        if (pointer.x !== null) {
          const distance = Math.hypot(node.x - pointer.x, node.y - pointer.y);
          if (distance < POINTER_DISTANCE) {
            ctx.beginPath();
            ctx.moveTo(node.x, node.y);
            ctx.lineTo(pointer.x, pointer.y);
            ctx.strokeStyle = `rgba(${color}, ${(1 - distance / POINTER_DISTANCE) * 0.4})`;
            ctx.lineWidth = 1;
            ctx.stroke();
          }
        }

        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${color}, 0.55)`;
        ctx.fill();
      }
    };

    const scheduleFrame = () => {
      if (!disposed && animation === null && document.visibilityState !== 'hidden') {
        animation = window.requestAnimationFrame(animate);
      }
    };

    const animate = (time) => {
      animation = null;
      if (disposed || document.visibilityState === 'hidden') return;
      if (!reducedMotion) {
        const delta = previousTime === null ? 0 : Math.min((time - previousTime) / (1000 / 60), 2);
        nodes.forEach(node => node.update(delta, width, height));
      }
      previousTime = time;
      draw();
      if (!reducedMotion) scheduleFrame();
    };

    const pause = () => {
      if (animation !== null) window.cancelAnimationFrame(animation);
      animation = null;
      previousTime = null;
    };

    const resize = () => {
      const nextWidth = window.innerWidth;
      const nextHeight = window.innerHeight;
      if (width && height) {
        nodes.forEach(node => {
          node.x = node.x / width * nextWidth;
          node.y = node.y / height * nextHeight;
        });
      }
      width = nextWidth;
      height = nextHeight;
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
      ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      scheduleFrame();
    };

    const handlePointerMove = (event) => {
      if (event.pointerType === 'touch') return;
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      scheduleFrame();
    };

    const clearPointer = () => {
      pointer.x = null;
      pointer.y = null;
      scheduleFrame();
    };

    const handleClick = (event) => {
      if (isInteractiveTarget(event.target)) return;
      if (event.clientX < 0 || event.clientX > width || event.clientY < 0 || event.clientY > height) return;
      const node = new Node(event.clientX, event.clientY);
      node.radius = 3;
      if (nodes.length >= MAX_NODES) nodes.shift();
      nodes.push(node);
      scheduleFrame();
    };

    const handleSelectStart = (event) => {
      // Repeated node clicks and drags shouldn't select the page underneath.
      if (!isInteractiveTarget(event.target)) event.preventDefault();
    };

    const handleMotionChange = (event) => {
      reducedMotion = event.matches;
      pause();
      scheduleFrame();
    };

    const handleVisibilityChange = () => {
      pause();
      pointer.x = null;
      pointer.y = null;
      scheduleFrame();
    };

    resize();
    for (let i = 0; i < INITIAL_NODES; i++) {
      nodes.push(new Node(Math.random() * width, Math.random() * height));
    }
    redrawRef.current = scheduleFrame;
    window.addEventListener('resize', resize);
    window.addEventListener('click', handleClick);
    document.addEventListener('selectstart', handleSelectStart);
    window.addEventListener('pointermove', handlePointerMove, { passive: true });
    window.addEventListener('blur', clearPointer);
    document.documentElement.addEventListener('pointerleave', clearPointer);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    if (motionPreference.addEventListener) {
      motionPreference.addEventListener('change', handleMotionChange);
    } else {
      motionPreference.addListener(handleMotionChange);
    }

    return () => {
      disposed = true;
      pause();
      redrawRef.current = null;
      window.removeEventListener('resize', resize);
      window.removeEventListener('click', handleClick);
      document.removeEventListener('selectstart', handleSelectStart);
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('blur', clearPointer);
      document.documentElement.removeEventListener('pointerleave', clearPointer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (motionPreference.removeEventListener) {
        motionPreference.removeEventListener('change', handleMotionChange);
      } else {
        motionPreference.removeListener(handleMotionChange);
      }
    };
  }, []);

  useEffect(() => {
    themeRef.current = theme;
    if (redrawRef.current) redrawRef.current();
  }, [theme]);

  return (
    <canvas
      ref={canvasRef}
      className="neural-network-background"
      aria-hidden="true"
      data-robot-ignore="true"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        zIndex: 0,
        pointerEvents: 'none',
      }}
    />
  );
}
