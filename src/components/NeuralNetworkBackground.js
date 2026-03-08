import React, { useEffect, useRef } from 'react';

class Node {
  constructor(x, y, canvas) {
    this.x = x;
    this.y = y;
    this.vx = (Math.random() - 0.5) * 0.8;
    this.vy = (Math.random() - 0.5) * 0.8;
    this.canvas = canvas;
    this.opacity = 1;
    this.fadeOut = false;
    this.radius = 2 + Math.random() * 2;
  }

  update() {
    this.x += this.vx;
    this.y += this.vy;

    if (this.x < 0 || this.x > this.canvas.width) this.vx *= -1;
    if (this.y < 0 || this.y > this.canvas.height) this.vy *= -1;

    if (this.fadeOut) {
      this.opacity -= 0.015;
    }

    this.x = Math.max(0, Math.min(this.canvas.width, this.x));
    this.y = Math.max(0, Math.min(this.canvas.height, this.y));
  }
}

export default function NeuralNetworkBackground() {
  const canvasRef = useRef(null);
  const nodesRef = useRef([]);
  const animationRef = useRef(null);
  const mouseRef = useRef({ x: null, y: null });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    let nodes = nodesRef.current;

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    resize();
    window.addEventListener('resize', resize);

    const nodeCount = Math.min(12, Math.max(12, Math.floor((canvas.width * canvas.height) / 48000)));

    for (let i = 0; i < nodeCount; i++) {
      nodes.push(new Node(
        Math.random() * canvas.width,
        Math.random() * canvas.height,
        canvas
      ));
    }

    const handleMouseMove = (e) => {
      mouseRef.current = {
        x: e.clientX,
        y: e.clientY
      };
    };

    const handleClick = (e) => {
      const x = e.clientX;
      const y = e.clientY;

      const newNode = new Node(x, y, canvas);
      newNode.radius = 3;
      nodes.push(newNode);
    };

    window.addEventListener('click', handleClick);
    window.addEventListener('mousemove', handleMouseMove);

    const connectionDistance = 360;
    const mouseConnectionDistance = 200;

    const animate = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      nodes = nodes.filter(node => node.opacity > 0);
      nodesRef.current = nodes;

      const mouse = mouseRef.current;

      if (mouse.x !== null && mouse.y !== null) {
        nodes.forEach(node => {
          const dx = node.x - mouse.x;
          const dy = node.y - mouse.y;
          const distance = Math.sqrt(dx * dx + dy * dy);

          if (distance < mouseConnectionDistance) {
            const opacity = (1 - distance / mouseConnectionDistance) * 0.6 * node.opacity;
            ctx.beginPath();
            ctx.moveTo(node.x, node.y);
            ctx.lineTo(mouse.x, mouse.y);
            ctx.strokeStyle = `rgba(148, 163, 184, ${opacity})`;
            ctx.lineWidth = 1.5;
            ctx.stroke();
          }
        });
      }

      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const dx = nodes[i].x - nodes[j].x;
          const dy = nodes[i].y - nodes[j].y;
          const distance = Math.sqrt(dx * dx + dy * dy);

          if (distance < connectionDistance) {
            const opacity = (1 - distance / connectionDistance) * 0.6 *
              Math.min(nodes[i].opacity, nodes[j].opacity);
            ctx.beginPath();
            ctx.moveTo(nodes[i].x, nodes[i].y);
            ctx.lineTo(nodes[j].x, nodes[j].y);
            ctx.strokeStyle = `rgba(148, 163, 184, ${opacity})`;
            ctx.lineWidth = 1;
            ctx.stroke();
          }
        }
      }

      nodes.forEach(node => {
        node.update();

        const nodeOpacity = node.opacity * 0.8;
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(148, 163, 184, ${nodeOpacity})`;
        ctx.fill();
      });

      animationRef.current = requestAnimationFrame(animate);
    };

    animate();

    return () => {
      window.removeEventListener('resize', resize);
      window.removeEventListener('click', handleClick);
      window.removeEventListener('mousemove', handleMouseMove);
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100vw',
        height: '100vh',
        zIndex: 0,
        pointerEvents: 'none',
      }}
    />
  );
}
