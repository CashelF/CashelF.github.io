import React from 'react';
import ReactDOM from 'react-dom';
import './index.css';
import App from './App';

const root = document.getElementById('root');
const render = root.hasChildNodes() ? ReactDOM.hydrate : ReactDOM.render;
render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
  root
);
