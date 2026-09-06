import * as THREE from "three/build/three";

export function brainPalette(theme) {
  return theme === "dark"
    ? { ink: "#a4af98", overviewInk: "#a0ad91", accent: "#ed9873", guide: "#a7b29b", residual: "#bba68d", label: "#b9c2ae", border: "#59634e", idle: "#738267" }
    : { ink: "#8d9186", overviewInk: "#949b89", accent: "#cf542f", guide: "#8d9487", residual: "#ad947d", label: "#666d5d", border: "#c6cabd", idle: "#bfc4b5" };
}

const NIGHT_GUIDE_COLORS = {
  0x858c7e: 0xa0af91,
  0x737c6c: 0xc2ccb7,
  0x838b7b: 0xb4c0a5,
  0x8b9284: 0xb4c0a5,
  0x8a9380: 0xb4c0a5,
  0xa38e75: 0xc5ac8e,
};

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Return only a value collected from this particular forward pass. */
export function measuredNode(frame, layer, descriptor) {
  const internals = frame && frame.internals;
  const fields = {
    query: "queryHeadRms",
    key: "keyHeadRms",
    value: "valueHeadRms",
    head: "attentionHeadRms",
    neuron: "mlpNeuronRms",
  };
  const names = {
    query: "Query projection",
    key: "Key projection",
    value: "Value projection",
    head: "Attention output",
  };
  const field = fields[descriptor.kind];
  if (field) {
    const row = internals && internals[field] && internals[field][layer];
    const value = row && row[descriptor.index];
    if (!finite(value)) return null;
    const channel = internals.neuronIndices && internals.neuronIndices[descriptor.index];
    return {
      title: descriptor.kind === "neuron"
        ? `Channel ${Number.isInteger(channel) ? channel : descriptor.index}`
        : `${names[descriptor.kind]} ${descriptor.index + 1}`,
      value,
      group: descriptor.group,
    };
  }
  if (descriptor.kind === "output") {
    const row = frame && frame.rawRms && frame.rawRms[layer];
    if (Array.isArray(row) && row.length && row.every(finite)) {
      return {
        title: "Residual output",
        value: row.reduce((sum, value) => sum + value, 0) / row.length,
      };
    }
  }
  return null;
}

/**
 * A selected decoder block. Edges, normalizations and skip connections are
 * architectural guides; only nodes with a matching telemetry value are colored.
 */
export function makeStructure({ queryHeads, kvHeads, channels, theme = "light" }) {
  const palette = brainPalette(theme);
  const themedMaterials = [];
  const group = new THREE.Group();
  const positions = [];
  const descriptors = [];
  const sizes = [];
  const connections = [];
  const rims = [];
  const resources = [];
  const groupedPaths = Array.from({ length: kvHeads }, () => []);
  const groupedBrackets = Array.from({ length: kvHeads }, () => []);
  const pathMaterials = [];
  const bracketMaterials = [];
  const queriesPerKv = queryHeads / kvHeads;
  const anchors = {
    input: new THREE.Vector3(-4.33, -0.36, 0),
    norm1: new THREE.Vector3(-3.89, -0.41, 0),
    qkv: new THREE.Vector3(-2.97, -1.12, 0),
    query: new THREE.Vector3(-3.42, 0.74, 0.28),
    key: new THREE.Vector3(-3.42, 0, 0.28),
    value: new THREE.Vector3(-3.42, -0.74, 0.28),
    attention: new THREE.Vector3(-1.05, -1.12, 0),
    outputProjection: new THREE.Vector3(-0.36, -0.39, 0),
    residual1: new THREE.Vector3(-1.91, 1.39, 0),
    norm2: new THREE.Vector3(0.84, -0.41, 0),
    gate: new THREE.Vector3(1.5, 0.58, 0),
    up: new THREE.Vector3(1.5, -0.57, 0),
    mlp: new THREE.Vector3(2.55, -1.12, 0),
    residual2: new THREE.Vector3(2.25, 1.39, 0),
    output: new THREE.Vector3(4.28, -0.37, 0),
  };

  function addNode(point, kind, index, size, attentionGroup) {
    positions.push(point.x, point.y, point.z);
    descriptors.push({ kind, index, group: attentionGroup });
    sizes.push(size);
  }
  function connect(from, to, target = connections) {
    target.push(from.x, from.y, from.z, to.x, to.y, to.z);
  }
  function themeMaterial(material, dayColor) {
    themedMaterials.push({ material, dayColor });
    material.color.setHex(theme === "dark" ? NIGHT_GUIDE_COLORS[dayColor] || dayColor : dayColor);
    return material;
  }
  function lines(points, color, opacity, order = 0) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
    const material = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthWrite: false,
      depthTest: false,
    });
    themeMaterial(material, color);
    const object = new THREE.LineSegments(geometry, material);
    object.renderOrder = order;
    group.add(object);
    resources.push(geometry, material);
    return material;
  }
  function rectangularPlane(x, halfY, halfZ, centerY = 0) {
    const corners = [
      new THREE.Vector3(x, centerY + halfY, -halfZ),
      new THREE.Vector3(x, centerY + halfY, halfZ),
      new THREE.Vector3(x, centerY - halfY, halfZ),
      new THREE.Vector3(x, centerY - halfY, -halfZ),
    ];
    corners.forEach((point, index) => connect(point, corners[(index + 1) % 4], rims));
  }
  function guideSymbol(point, symbol, radius = 0.12) {
    const geometry = new THREE.RingBufferGeometry(radius, radius + 0.016, 32);
    const material = new THREE.MeshBasicMaterial({
      color: 0x858c7e,
      transparent: true,
      opacity: 0.65,
      side: THREE.DoubleSide,
      depthWrite: false,
      depthTest: false,
    });
    themeMaterial(material, 0x858c7e);
    const ring = new THREE.Mesh(geometry, material);
    ring.position.copy(point);
    ring.renderOrder = 1;
    group.add(ring);
    resources.push(geometry, material);
    if (symbol) {
      const marks = [];
      const r = radius * 0.55;
      const diagonals = symbol === "multiply";
      connect(
        new THREE.Vector3(point.x - r, point.y - (diagonals ? r : 0), point.z),
        new THREE.Vector3(point.x + r, point.y + (diagonals ? r : 0), point.z),
        marks,
      );
      connect(
        new THREE.Vector3(point.x - (diagonals ? r : 0), point.y + r, point.z),
        new THREE.Vector3(point.x + (diagonals ? r : 0), point.y - r, point.z),
        marks,
      );
      lines(marks, 0x737c6c, 0.8, 2);
    }
  }

  const entry = new THREE.Vector3(-4.33, 0, 0);
  const norm1 = new THREE.Vector3(-3.86, 0, 0);
  const projectionFeed = new THREE.Vector3(-3.65, 0, 0);
  const attentionOutput = new THREE.Vector3(-0.34, 0, 0);
  const firstMerge = new THREE.Vector3(0.22, 0, 0);
  const norm2 = new THREE.Vector3(0.84, 0, 0);
  const mlpFeed = new THREE.Vector3(1.08, 0, 0);
  const gate = new THREE.Vector3(1.52, 0.33, 0);
  const up = new THREE.Vector3(1.52, -0.33, 0);
  const product = new THREE.Vector3(1.99, 0, 0);
  const downProjection = new THREE.Vector3(3.39, 0, 0);
  const secondMerge = new THREE.Vector3(3.94, 0, 0);
  const output = new THREE.Vector3(4.34, 0, 0);
  addNode(entry, "guide", 0, 4.5);
  addNode(attentionOutput, "guide", 0, 5);
  addNode(gate, "guide", 0, 4);
  addNode(up, "guide", 0, 4);
  addNode(downProjection, "guide", 0, 4.5);
  addNode(output, "output", 0, 7.5);
  connect(entry, norm1);
  connect(norm1, projectionFeed);
  connect(attentionOutput, firstMerge);
  connect(firstMerge, norm2);
  connect(norm2, mlpFeed);
  connect(mlpFeed, gate);
  connect(mlpFeed, up);
  connect(gate, product);
  connect(up, product);
  connect(downProjection, secondMerge);
  connect(secondMerge, output);
  guideSymbol(norm1, null, 0.115);
  guideSymbol(norm2, null, 0.115);
  guideSymbol(firstMerge, "plus", 0.145);
  guideSymbol(secondMerge, "plus", 0.145);
  guideSymbol(product, "multiply", 0.085);

  // Three distinct projection lanes all branch from the same normalized input.
  // Two query heads share the same key/value heads in the current 16Q / 8KV model.
  const projectionColumns = Math.min(4, kvHeads);
  const projectionRows = Math.ceil(kvHeads / projectionColumns);
  const attentionColumns = Math.max(1, Math.ceil(kvHeads / 4));
  const attentionRows = Math.ceil(kvHeads / attentionColumns);
  const projectionCenters = [0.74, 0, -0.74];
  projectionCenters.forEach((y) => {
    const bus = new THREE.Vector3(-3.28, y, 0);
    connect(projectionFeed, bus);
    rectangularPlane(-2.98, 0.18, 0.54, y);
  });

  function projectionPoint(attentionGroup, lane, offset = 0) {
    const row = Math.floor(attentionGroup / projectionColumns);
    const column = attentionGroup % projectionColumns;
    return new THREE.Vector3(
      -2.98,
      projectionCenters[lane] + ((projectionRows - 1) / 2 - row) *
        Math.min(0.17, 0.22 / Math.max(1, projectionRows - 1)) + offset,
      (column - (projectionColumns - 1) / 2) * 0.28,
    );
  }
  function attentionCenter(attentionGroup) {
    const row = Math.floor(attentionGroup / attentionColumns);
    const column = attentionGroup % attentionColumns;
    return new THREE.Vector3(
      -1.08,
      ((attentionRows - 1) / 2 - row) * Math.min(0.43, 1.34 / Math.max(1, attentionRows - 1)),
      (column - (attentionColumns - 1) / 2) * Math.min(0.69, 1.38 / Math.max(1, attentionColumns - 1)),
    );
  }

  for (let attentionGroup = 0; attentionGroup < kvHeads; attentionGroup += 1) {
    const paths = groupedPaths[attentionGroup];
    const center = attentionCenter(attentionGroup);
    const key = projectionPoint(attentionGroup, 1);
    const value = projectionPoint(attentionGroup, 2);
    addNode(key, "key", attentionGroup, 5.4, attentionGroup);
    addNode(value, "value", attentionGroup, 5.4, attentionGroup);
    connect(new THREE.Vector3(-3.28, 0, 0), key, paths);
    connect(new THREE.Vector3(-3.28, -0.74, 0), value, paths);
    // Shared K and V paths meet a pair of query heads. The endpoints describe
    // head grouping, not measured attention probabilities or individual tokens.
    const sharedKey = new THREE.Vector3(-1.57, center.y + 0.045, center.z - 0.07);
    const sharedValue = new THREE.Vector3(-1.57, center.y - 0.045, center.z + 0.07);
    connect(key, sharedKey, paths);
    connect(value, sharedValue, paths);
    for (let member = 0; member < queriesPerKv; member += 1) {
      const head = attentionGroup * queriesPerKv + member;
      const offset = ((queriesPerKv - 1) / 2 - member) * Math.min(0.16, 0.22 / Math.max(1, queriesPerKv - 1));
      const query = projectionPoint(attentionGroup, 0, offset * 0.42);
      const headPoint = center.clone();
      headPoint.y += offset;
      addNode(query, "query", head, 5, attentionGroup);
      addNode(headPoint, "head", head, 8.6, attentionGroup);
      connect(new THREE.Vector3(-3.28, 0.74, 0), query, paths);
      connect(query, headPoint, paths);
      connect(sharedKey, headPoint, paths);
      connect(sharedValue, headPoint, paths);
      connect(headPoint, attentionOutput, paths);
    }
    // Each small bracket encloses precisely the query heads sharing a KV pair.
    const bracket = groupedBrackets[attentionGroup];
    const topLeft = new THREE.Vector3(-1.39, center.y + 0.18, center.z);
    const topRight = new THREE.Vector3(-0.8, center.y + 0.18, center.z);
    const bottomRight = new THREE.Vector3(-0.8, center.y - 0.18, center.z);
    const bottomLeft = new THREE.Vector3(-1.39, center.y - 0.18, center.z);
    connect(topLeft, topRight, bracket);
    connect(topRight, bottomRight, bracket);
    connect(bottomRight, bottomLeft, bracket);
  }

  const channelColumns = Math.min(8, channels);
  const channelRows = Math.ceil(channels / channelColumns);
  for (let channel = 0; channel < channels; channel += 1) {
    const point = new THREE.Vector3(
      2.59,
      ((channelRows - 1) / 2 - Math.floor(channel / channelColumns)) *
        Math.min(0.35, 1.15 / Math.max(1, channelRows - 1)),
      ((channel % channelColumns) - (channelColumns - 1) / 2) * 0.18,
    );
    addNode(point, "neuron", channel, 6.1);
    connect(product, point);
    connect(point, downProjection);
  }
  rectangularPlane(2.59, 0.72, 0.78);
  lines(connections, 0x838b7b, 0.2);
  lines(rims, 0x8b9284, 0.22);
  groupedPaths.forEach((paths) => pathMaterials.push(lines(paths, 0x838b7b, 0.13)));
  groupedBrackets.forEach((bracket) => bracketMaterials.push(lines(bracket, 0x8a9380, 0.32)));

  // A bypass starts before its RMSNorm and rejoins at its own addition.
  [[entry, firstMerge], [firstMerge, secondMerge]].forEach(([start, end]) => {
    const curve = new THREE.CubicBezierCurve3(
      start,
      new THREE.Vector3(start.x + 0.03, 1.63, 0),
      new THREE.Vector3(end.x - 0.03, 1.63, 0),
      end,
    );
    const geometry = new THREE.BufferGeometry().setFromPoints(curve.getPoints(48));
    const material = new THREE.LineBasicMaterial({
      color: 0xa38e75,
      transparent: true,
      opacity: 0.59,
      depthWrite: false,
      depthTest: false,
    });
    themeMaterial(material, 0xa38e75);
    group.add(new THREE.Line(geometry, material));
    resources.push(geometry, material);
  });

  const nodeGeometry = new THREE.BufferGeometry();
  const magnitudes = new Float32Array(descriptors.length);
  const measured = new Float32Array(descriptors.length);
  const emphasis = new Float32Array(descriptors.length);
  nodeGeometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  nodeGeometry.setAttribute("dotSize", new THREE.Float32BufferAttribute(sizes, 1));
  nodeGeometry.setAttribute("magnitude", new THREE.BufferAttribute(magnitudes, 1));
  nodeGeometry.setAttribute("measured", new THREE.BufferAttribute(measured, 1));
  nodeGeometry.setAttribute("emphasis", new THREE.BufferAttribute(emphasis, 1));
  const nodeMaterial = new THREE.ShaderMaterial({
    uniforms: {
      ink: { value: new THREE.Color(palette.ink) },
      accent: { value: new THREE.Color(palette.accent) },
      pixelRatio: { value: 1 },
      pointScale: { value: 1 },
    },
    vertexShader: `
      attribute float magnitude;
      attribute float measured;
      attribute float emphasis;
      attribute float dotSize;
      uniform float pixelRatio;
      uniform float pointScale;
      varying float vMagnitude;
      varying float vMeasured;
      varying float vEmphasis;
      void main() {
        vMagnitude = magnitude;
        vMeasured = measured;
        vEmphasis = emphasis;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = dotSize * pixelRatio * pointScale * (1.0 + magnitude * 0.28 + max(0.0, emphasis) * 0.16);
      }
    `,
    fragmentShader: `
      uniform vec3 ink;
      uniform vec3 accent;
      varying float vMagnitude;
      varying float vMeasured;
      varying float vEmphasis;
      void main() {
        vec2 point = gl_PointCoord * 2.0 - vec2(1.0);
        float radius = dot(point, point);
        if (radius > 1.0) discard;
        vec3 normal = vec3(point.x, -point.y, sqrt(1.0 - radius));
        float light = 0.72 + 0.28 * max(0.0, dot(normal, normalize(vec3(-0.4, 0.7, 1.0))));
        float strength = vMagnitude * vMeasured;
        vec3 color = mix(ink, accent, clamp(0.15 * vMeasured + strength, 0.0, 1.0));
        float edge = 1.0 - smoothstep(0.76, 1.0, radius);
        float opacity = vEmphasis < -0.5 ? 0.25 : mix(0.8, 1.0, vMeasured);
        gl_FragColor = vec4(color * light, edge * opacity);
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: false,
  });
  const nodes = new THREE.Points(nodeGeometry, nodeMaterial);
  nodes.renderOrder = 3;
  group.add(nodes);
  resources.push(nodeGeometry, nodeMaterial);

  return {
    group,
    nodes,
    descriptors,
    anchors,
    updateTheme(nextTheme) {
      theme = nextTheme;
      const nextPalette = brainPalette(theme);
      nodeMaterial.uniforms.ink.value.set(nextPalette.ink);
      nodeMaterial.uniforms.accent.value.set(nextPalette.accent);
      themedMaterials.forEach(({ material, dayColor }) => {
        material.color.setHex(theme === "dark" ? NIGHT_GUIDE_COLORS[dayColor] || dayColor : dayColor);
      });
    },
    update(frame, selectedLayer, pixelRatio, width, highlightGroup = null) {
      const highlighting = Number.isInteger(highlightGroup) && highlightGroup >= 0 && highlightGroup < kvHeads;
      descriptors.forEach((descriptor, index) => {
        const detail = measuredNode(frame, selectedLayer, descriptor);
        magnitudes[index] = detail ? detail.value / (1 + detail.value) : 0;
        measured[index] = detail ? 1 : 0;
        emphasis[index] = highlighting && Number.isInteger(descriptor.group)
          ? (descriptor.group === highlightGroup ? 1 : -1) : 0;
      });
      pathMaterials.forEach((material, index) => {
        material.opacity = highlighting ? (index === highlightGroup ? 0.64 : 0.035) : 0.13;
      });
      bracketMaterials.forEach((material, index) => {
        material.opacity = highlighting ? (index === highlightGroup ? 0.8 : 0.1) : 0.32;
      });
      nodeGeometry.attributes.magnitude.needsUpdate = true;
      nodeGeometry.attributes.measured.needsUpdate = true;
      nodeGeometry.attributes.emphasis.needsUpdate = true;
      nodeMaterial.uniforms.pixelRatio.value = pixelRatio;
      nodeMaterial.uniforms.pointScale.value = width < 480 ? 0.69 : 0.92;
    },
    dispose() {
      resources.forEach((resource) => resource.dispose());
    },
  };
}
