import React from 'react';

const styles = {
  bentoBox: {
    display: 'flex',
    flexDirection: 'column',
    borderRadius: '16px',
    overflow: 'hidden',
    position: 'relative',
    background: 'rgba(17, 24, 39, 0.6)',
    backdropFilter: 'blur(16px)',
    WebkitBackdropFilter: 'blur(16px)',
    border: '1px solid rgba(148, 163, 184, 0.2)',
    transition: 'all 0.3s ease',
    textDecoration: 'none',
    color: 'inherit',
    boxShadow: '0 4px 24px rgba(0, 0, 0, 0.25), inset 0 1px 0 rgba(255, 255, 255, 0.05)',
  },
  bentoImageContainer: {
    position: 'relative',
    width: '100%',
    overflow: 'hidden',
    background: 'rgba(0, 0, 0, 0.2)',
  },
  bentoImage: {
    width: '100%',
    height: '140px',
    objectFit: 'cover',
    objectPosition: 'top left',
    transition: 'transform 0.4s ease',
  },
  bentoOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: 'linear-gradient(to bottom, transparent 0%, transparent 30%, rgba(17, 24, 39, 0.9) 100%)',
  },
  bentoContent: {
    padding: '1rem',
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
  },
  bentoSubtitle: {
    fontSize: '0.7rem',
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: '#a78bfa',
    marginBottom: '0.25rem',
  },
  bentoTitle: {
    fontSize: '1rem',
    fontWeight: 600,
    color: 'white',
    margin: '0 0 0.5rem 0',
    lineHeight: 1.3,
  },
  bentoDescription: {
    fontSize: '0.8rem',
    lineHeight: 1.5,
    color: '#9ca3af',
    margin: 0,
    overflow: 'hidden',
    display: '-webkit-box',
    WebkitLineClamp: 3,
    WebkitBoxOrient: 'vertical',
  },
};

export default function BentoBox({ project }) {
  const handleImageError = (e) => {
    e.target.src = project.thumbnail;
  };

  const [isHovered, setIsHovered] = React.useState(false);

  const hoverStyles = isHovered ? {
    borderColor: 'rgba(148, 163, 184, 0.5)',
    boxShadow: '0 4px 24px rgba(0, 0, 0, 0.35), 0 0 30px rgba(148, 163, 184, 0.15), inset 0 1px 0 rgba(255, 255, 255, 0.1)',
    transform: 'translateY(-4px)',
    background: 'rgba(17, 24, 39, 0.75)',
  } : {};

  const imageHoverStyles = isHovered ? {
    transform: 'scale(1.05)',
  } : {};

  return (
    <a 
      href={project.link} 
      target="_blank" 
      rel="noreferrer"
      style={{ ...styles.bentoBox, ...hoverStyles }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div style={styles.bentoImageContainer}>
        <img
          src={project.image}
          onError={handleImageError}
          alt={project.title}
          style={{ ...styles.bentoImage, ...imageHoverStyles }}
        />
        <div style={styles.bentoOverlay} />
      </div>
      <div style={styles.bentoContent}>
        <span style={styles.bentoSubtitle}>{project.subtitle}</span>
        <h3 style={styles.bentoTitle}>{project.title}</h3>
        <p style={styles.bentoDescription}>{project.description}</p>
      </div>
    </a>
  );
}
