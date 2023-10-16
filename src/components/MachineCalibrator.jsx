import React, { useCallback, useEffect, useState } from 'react';
import { connect } from 'react-redux';
import styled from 'styled-components';

import MachineJogControl from './MachineJogControl';
import AnnotatedVideo from './AnnotatedVideo';
import { applyHomography, findChessboard, swapOrder } from '../cv';
import { chunk } from '../util';
import MatrixTable from './MatrixTable';

const Row = styled.div`
  display: flex;
  flex-direction: row;
  flex: 1;
`;

const Column = styled.div`
  display: flex;
  flex-direction: column;
  flex: 1;
`;

const ScrollableList = styled.ul`
  overflow-y: scroll;
  flex: 1;
`;

function chessboardOuterCorners(cornersMat, rows, cols) {
  const gridPts = chunk(cornersMat.data32F, 2);

  // Grid points in "U" shape order for the user to navigate to in sequence
  return [
    gridPts[0], // Upper left
    gridPts[cols - 1], // Upper right
    gridPts[rows * cols - 1], // Lower right
    gridPts[(rows - 1) * cols], // Lower left
  ];
}

function MachineCalibrator({
  cncConnected,
  cncAtHome,
  cncPosition,
  toolpath,
  bedDimensions,
  chessboardRows,
  chessboardCols,
  cameraToCNC,
  dispatch,
}) {
  const [videoEl, setVideoEl] = useState();
  const [pointPairs, setPointPairs] = useState([]);
  const [chessboardPoints, setChessboardPoints] = useState();
  const [nextCornerIndex, setNextCornerIndex] = useState(0);

  const transform = (() => {
    if (cameraToCNC === undefined) {
      return [1, 0, 0, 0, 1, 0, 0, 0, 1];
    }

    let camToCNCMat = cv.matFromArray(3, 3, cv.CV_32F, cameraToCNC); // Deleted after use below
    let cncToCam = new cv.Mat(); // Deleted after use in transforming points
    cv.invert(camToCNCMat, cncToCam);
    const t = cncToCam.data32F;
    cncToCam.delete(); cncToCam = undefined;
    camToCNCMat.delete(); camToCNCMat = undefined;

    return swapOrder(t);
  })();

  // TODO: we only need to rerender these things when they change, not every frame
  const handleUpdate = useCallback((video, canvas) => {
    if (videoEl === undefined) {
      setVideoEl(video);
    }

    const ctx = canvas.getContext('2d');
    // ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (chessboardPoints !== undefined) {
      const gridCorners = chessboardOuterCorners(chessboardPoints, chessboardRows, chessboardCols);

      // Highlight the 4 grid corner points
      const radius = 4;
      ctx.fillStyle = '#44ff44';
      gridCorners.forEach(([x, y]) => {
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, 2 * Math.PI);
        ctx.fill();
      });

      // Mark an X for the next corner the user should navigate to
      if (nextCornerIndex < gridCorners.length) {
        const [x, y] = gridCorners[nextCornerIndex];

        const markSize = 10;
        ctx.strokeStyle = '#ff4444';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x - markSize, y - markSize);
        ctx.lineTo(x + markSize, y + markSize);
        ctx.moveTo(x - markSize, y + markSize);
        ctx.lineTo(x + markSize, y - markSize);
        ctx.stroke();
      }
    }

    // If we have a valid homography, then
    // render a border around the CNC bed
    // and render the toolpath if we have one
    if (cameraToCNC !== undefined) {
      let camToCNCMat = cv.matFromArray(3, 3, cv.CV_32F, cameraToCNC); // Deleted after use below
      let cncToCam = new cv.Mat(); // Deleted after use in transforming points
      cv.invert(camToCNCMat, cncToCam);
      camToCNCMat.delete(); camToCNCMat = undefined;

      const bedCorners = [
        [0, 0],
        [bedDimensions.widthMM, 0],
        [bedDimensions.widthMM, bedDimensions.heightMM],
        [0, bedDimensions.heightMM],
      ];//.map(([x, y]) => applyHomography(cncToCam, x, y));

      ctx.strokeStyle = '#ff4444';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(bedCorners[0][0], bedCorners[0][1]);
      bedCorners.slice(1).forEach((corner) => {
        ctx.lineTo(corner[0], corner[1]);
      });
      ctx.lineTo(bedCorners[0][0], bedCorners[0][1]);
      ctx.stroke();

      if (toolpath !== undefined) {
        const toolpathInCam = toolpath
          .map((path) => path
            .map(({ x, y }) => {
              // Flip the Y axis because the CNC's Y axis is flipped
              const ny = 235 - y;
              const nx = x;
              return { x: nx, y: ny };
            })
            .map(({ x, y }) => [x, y]));
            //.map(({ x, y }) => applyHomography(cncToCam, x, y)));

        ctx.strokeStyle = '#4444ff';
        ctx.lineWidth = 1;
        toolpathInCam.forEach((path) => {
          ctx.beginPath();
          ctx.moveTo(path[0][0], path[0][1]);
          path.slice(1).forEach(([x, y]) => ctx.lineTo(x, y));
          ctx.stroke();
        });
      }

      // cncToCam.delete(); cncToCam = undefined;
    }
  }, [setVideoEl, chessboardPoints, cameraToCNC, nextCornerIndex]);

  // When the CNC is at its home position look for the chessboard every so often
  // Don't look for the chessboard when the CNC is not at home to avoid jank
  useEffect(() => {
    const interval = setInterval(() => {
      if (!cncAtHome) {
        return;
      }

      // Deleted the next time we setChessboardPoints below
      const corners = findChessboard(videoEl);

      if (corners === undefined) {
        return;
      }

      if (chessboardPoints !== undefined) {
        chessboardPoints.delete();
      }

      setChessboardPoints(corners);
    }, 1000);

    return () => clearInterval(interval);
  }, [cncAtHome, videoEl, chessboardPoints, setChessboardPoints]);

  const computeHomography = useCallback((currentPointPairs) => {
    const [machinePoints, imagePoints] = currentPointPairs.reduce((acc, { machine, image }) => {
      acc[0].push(...machine);
      acc[1].push(...image);
      return acc;
    }, [[], []]);

    // Figured out the data formats via
    // https://stackoverflow.com/a/63695553
    // Deleted after use below
    let machinePointsMat = cv.matFromArray(currentPointPairs.length, 2, cv.CV_32F, machinePoints);
    // Deleted after use below
    let imagePointsMat = cv.matFromArray(currentPointPairs.length, 2, cv.CV_32F, imagePoints);
    // Deleted after use below
    let imageToMachine = cv.findHomography(imagePointsMat, machinePointsMat); // CV_64F
    machinePointsMat.delete(); machinePointsMat = undefined;
    imagePointsMat.delete(); imagePointsMat = undefined;

    console.log('imageToMachine', imageToMachine.data64F);

    dispatch({
      type: 'CALIBRATION_CAM_TO_CNC',
      payload: Array.from(imageToMachine.data64F),
    });

    imageToMachine.delete(); imageToMachine = undefined;
  }, [dispatch]);

  const handleMachineAtPoint = useCallback(() => {
    const { x: cncX, y: cncY } = cncPosition;

    const gridCorners = chessboardOuterCorners(chessboardPoints, chessboardRows, chessboardCols);
    const [x, y] = gridCorners[nextCornerIndex];

    const newPointPairs = [...pointPairs, {
      machine: [cncX, cncY],
      image: [x, y],
    }];
    setPointPairs(newPointPairs);

    setNextCornerIndex(nextCornerIndex === 3 ? 0 : nextCornerIndex + 1);

    if (newPointPairs.length >= 4) {
      // We have enough points to compute the homography
      computeHomography(newPointPairs);
    }
  }, [
    chessboardPoints,
    cncPosition,
    pointPairs,
    setPointPairs,
    nextCornerIndex,
    setNextCornerIndex,
    dispatch,
  ]);

  // FIXME: hacked for playing around at HH
  window.cncAtPosition = (x, y) => {
    // console.log(`Manually setting the CNC position to (${x}, ${y})`);
    dispatch({ type: 'CNC_MOVED', payload: { x, y } });
  };

  const readyToMark = chessboardPoints !== undefined && cncConnected && cncPosition !== undefined;

  // FIXME: just for testing!
  // useEffect(() => {
  //   setTimeout(() => {
  //     setPointPairs([
  //       {
  //         machine: [94, 48],
  //         image: [662.80, 285.43],
  //       },
  //       {
  //         machine: [304.50, 46.50],
  //         image: [816.22, 270.23],
  //       },
  //       {
  //         machine: [305.75, 177.25],
  //         image: [824.31, 365.20],
  //       },
  //       {
  //         machine: [95.75, 179.00],
  //         image: [671.55, 377.51],
  //       },
  //     ]);
  //   }, 2000);
  // }, []);
  //
  // useEffect(() => {
  //   if (pointPairs.length >= 4) {
  //     computeHomography();
  //   }
  // }, [pointPairs, cameraToCNC]);

  return (
    <Row>
      <Column>
        <AnnotatedVideo onUpdate={handleUpdate} transform={transform} />
      </Column>
      <Column>
        <MachineJogControl />
        <button
          type="button"
          disabled={!readyToMark}
          onClick={handleMachineAtPoint}
        >
          Machine At Point
        </button>
        {cameraToCNC !== undefined && (
          <MatrixTable title="Camera to CNC" values={cameraToCNC} />
        )}
        <ScrollableList>
          {pointPairs.map(({ machine, image }) => {
            const [mx, my] = machine.map((v) => v.toFixed(2));
            const [ix, iy] = image.map((v) => v.toFixed(2));
            const str = `(${mx}, ${my}) => (${ix}, ${iy})`;

            return (
              <li key={str}>
                <span>{str}</span>
              </li>
            );
          })}
        </ScrollableList>
      </Column>
    </Row>
  );
}

function mapStateToProps(state) {
  return {
    cncConnected: state.cnc.connected,
    cncAtHome: state.cnc.atHome,
    cncPosition: state.cnc.lastCommandedPos,
    toolpath: state.cnc.toolpath,
    bedDimensions: state.cnc.bedDimensions,
    chessboardRows: state.calibration.chessboard.rows,
    chessboardCols: state.calibration.chessboard.cols,
    cameraToCNC: state.calibration.cameraToCNC,
  };
}

export default connect(mapStateToProps)(MachineCalibrator);
