/** Copyright Stewart Allen <sa@grid.space> -- All Rights Reserved */

"use strict";

(function() {

    let KIRI = self.kiri,
        BASE = self.base,
        POLY = BASE.polygons,
        UTIL = BASE.util,
        CAM = KIRI.driver.CAM,
        PRO = CAM.process,
        newPoint = BASE.newPoint;

    /**
     * DRIVER PRINT CONTRACT
     *
     * @param {Object} print state object
     * @param {Function} update incremental callback
     * @param {Number} [index] into widget array
     * @param {Object} [firstPoint] starting point
     */
    CAM.printSetup = function(print, update, index, firstPoint) {
        let widgetIndex = index || 0,
            widgetArray = print.widgets,
            widgetCount = widgetArray.length,
            widget = widgetArray[widgetIndex];

        if (widgetIndex >= widgetCount || !widget) return;

        let settings = print.settings,
            device = settings.device,
            process = settings.process,
            stock = settings.stock,
            outer = settings.bounds,
            outerz = outer.max.z,
            slices = widget.slices,
            bounds = widget.getCamBounds(settings),
            boundsz = bounds.max.z,
            hasStock = process.camStockOffset || (process.camStockZ && process.camStockX && process.camStockY),
            startCenter = process.outputOriginCenter,
            alignTop = settings.controller.alignTop,
            zclear = (process.camZClearance || 1),
            zmax_outer = hasStock ? stock.z + zclear : outerz + zclear,
            ztOff = process.camZTopOffset,
            zadd = hasStock ? stock.z - boundsz : alignTop ? outerz - boundsz : 0,
            zmax = outerz + zclear,
            wmpos = widget.mesh.position,
            wmx = wmpos.x,
            wmy = wmpos.y,
            originx = startCenter ? 0 : hasStock ? -stock.x / 2 : bounds.min.x,
            originy = startCenter ? 0 : hasStock ? -stock.y / 2 : bounds.min.y,
            origin = newPoint(originx + wmx, originy + wmy, zmax),
            output = print.output,
            easeDown = process.camEaseDown,
            depthFirst = process.camDepthFirst,
            tolerance = process.camTolerance,
            drillDown = process.camDrillDown,
            drillLift = process.camDrillLift,
            drillDwell = process.camDrillDwell,
            newOutput = widgetIndex === 0 ? [] : print.output,
            layerOut = [],
            printPoint,
            isNewMode,
            tool,
            toolDiam,
            toolDiamMove,
            feedRate,
            plungeRate,
            lastTool,
            lastMode,
            lastPoint,
            nextIsMove = true,
            spindle = 0,
            spindleMax = device.spindleMax,
            addOutput = print.addOutput,
            tip2tipEmit = print.tip2tipEmit,
            poly2polyEmit = print.poly2polyEmit,
            poly2polyDepthFirstEmit = print.poly2polyDepthFirstEmit,
            maxToolDiam = widget.maxToolDiam,
            terrain = widget.terrain.map(data => {
                return {
                    z: data.z,
                    tops: data.tops,
                };
            });

        function newLayer() {
            if (layerOut.length < 2) {
                return;
            }
            newOutput.push(layerOut);
            layerOut = [];
            layerOut.spindle = spindle;
        }

        function setTool(toolID, feed, plunge) {
            if (toolID !== lastTool) {
                tool = new CAM.Tool(settings, toolID);
                toolDiam = tool.fluteDiameter();
                toolDiamMove = toolDiam; // TODO validate w/ multiple models
                lastTool = toolID;
            }
            feedRate = feed;
            plungeRate = plunge;
        }

        function emitDrills(polys) {
            polys = polys.slice();
            for (;;) {
                let closestDist = Infinity,
                    closestI,
                    closest = null,
                    dist;

                for (let i=0; i<polys.length; i++) {
                    if (!polys[i]) continue;
                    if ((dist = polys[i].first().distTo2D(printPoint)) < closestDist) {
                        closestDist = dist;
                        closest = polys[i];
                        closestI = i;
                    }
                }

                if (!closest) return;
                polys[closestI] = null;
                printPoint = closest.first();
                emitDrill(closest, drillDown, drillLift, drillDwell);
            }
            // TODO emit in next-closest-order
            // polys.forEach(function(poly) {
            //     emitDrill(poly, drillDown, drillLift, drillDwell);
            // });
        }

        function emitDrill(poly, down, lift, dwell) {
            let remain = poly.first().z - poly.last().z,
                points = [],
                point = poly.first();
            for (;;) {
                if (remain > down * 2) {
                    points.push(point.clone());
                    point.z -= down;
                    remain -= down;
                } else if (remain < down) {
                    points.push(point.clone());
                    point.z -= remain;
                    points.push(point.clone());
                    break;
                } else {
                    points.push(point.clone());
                    point.z -= remain / 2;
                    points.push(point.clone());
                    point.z -= remain / 2;
                    points.push(point.clone());
                    break;
                }
            }
            points.forEach(function(point, index) {
                camOut(point, 1);
                if (index > 0 && index < points.length - 1) {
                    if (dwell) camDwell(dwell);
                    if (lift) camOut(point.clone().setZ(point.z + lift), 0);
                }
            })
            camOut(point.clone().setZ(zmax));
            newLayer();
        }

        /**
         * @param {Point} point
         * @param {number} emit (0=move, !0=filament emit/laser on/cut mode)
         * @param {number} [speed] speed
         * @param {number} [tool] tool
         */
        function layerPush(point, emit, speed, tool) {
            layerOut.mode = lastMode;
            addOutput(layerOut, point, emit, speed, tool);
        }

        function camDwell(time) {
            layerPush(
                null,
                0,
                time,
                tool.getNumber()
            );
        }

        function camOut(point, cut) {
            point = point.clone();
            point.x += wmx;
            point.y += wmy;
            point.z += zadd;

            if (nextIsMove) {
                cut = 0;
                nextIsMove = false;
            }
            let rate = feedRate;

            if (!lastPoint) {
                let above = point.clone().setZ(zmax + zadd);
                // before first point, move cutting head to point above it
                layerPush(above, 0, 0, tool.getNumber());
                // then set that as the lastPoint
                lastPoint = above;
            }

            let deltaXY = lastPoint.distTo2D(point),
                deltaZ = point.z - lastPoint.z,
                absDeltaZ = Math.abs(deltaZ),
                isMove = !cut;
            // drop points too close together
            if (deltaXY < 0.001 && point.z === lastPoint.z) {
                console.trace(["drop dup",lastPoint,point]);
                return;
            }
            if (isMove && deltaXY <= toolDiamMove) {
                // convert short planar moves to cuts
                 if (absDeltaZ <= tolerance) {
                    cut = 1;
                    isMove = false;
                } else if (deltaZ <= -tolerance) {
                    // move over before descending
                    layerPush(point.clone().setZ(lastPoint.z), 0, 0, tool.getNumber());
                    // new pos for plunge calc
                    deltaXY = 0;
                }
            } //else (TODO verify no else here b/c above could change isMove)
            // move over things
            if ((deltaXY > toolDiam || (deltaZ > toolDiam && deltaXY > tolerance)) && (isMove || absDeltaZ >= tolerance)) {
                let maxz = getZClearPath(
                        terrain,
                        lastPoint.x,// - wmx,
                        lastPoint.y,// - wmy,
                        point.x,// - wmx,
                        point.y,// - wmy,
                        Math.max(point.z, lastPoint.z),
                        zadd,
                        maxToolDiam/2,
                        zclear
                    ) + ztOff,
                    mustGoUp = Math.max(maxz - point.z, maxz - lastPoint.z) >= tolerance,
                    clearz = maxz;
                // up if any point between higher than start/outline
                if (mustGoUp) {
                    clearz = maxz + zclear;
                    layerPush(lastPoint.clone().setZ(clearz), 0, 0, tool.getNumber());
                }
                // over to point above where we descend to
                if (mustGoUp || point.z < maxz) {
                    layerPush(point.clone().setZ(clearz), 0, 0, tool.getNumber());
                    // new pos for plunge calc
                    deltaXY = 0;
                }
            }
            // synth new plunge rate
            if (deltaZ <= -tolerance) {
                let threshold = Math.min(deltaXY / 2, absDeltaZ),
                    modifier = threshold / absDeltaZ;
                if (threshold && modifier && deltaXY > tolerance) {
                    // use modifier to speed up long XY move plunge rates
                    rate = Math.round(plungeRate + ((feedRate - plungeRate) * modifier));
                } else {
                    rate = plungeRate;
                }
                // console.log({deltaZ: deltaZ, deltaXY: deltaXY, threshold:threshold, modifier:modifier, rate:rate, plungeRate:plungeRate});
            }

            // todo synthesize move speed from feed / plunge accordingly
            layerPush(
                point,
                cut ? 1 : 0,
                rate,
                tool.getNumber()
            );
            lastPoint = point;
            layerOut.spindle = spindle;
        }

        // coming from a previous widget, use previous last point
        lastPoint = firstPoint;

        // make top start offset configurable
        printPoint = firstPoint || origin;

        // accumulated data for depth-first optimiztions
        let depthData = {
            rough: [],
            outline: [],
            roughDiam: 0,
            outlineDiam: 0,
            contourx: [],
            contoury: [],
            layer: 0,
            drill: []
        };

        // todo first move into positon
        slices.forEach(function(slice, sliceIndex) {
            depthData.layer++;
            isNewMode = slice.camMode != lastMode;
            lastMode = slice.camMode;
            nextIsMove = true;
            if (isNewMode) depthData.layer = 0;

            switch (slice.camMode) {
                case PRO.LEVEL:
                    setTool(process.camRoughTool, process.camRoughSpeed, 0);
                    spindle = Math.min(spindleMax, process.camRoughSpindle);
                    slice.tops.forEach(function(top) {
                        if (!top.traces) return;
                        let polys = [];
                        top.traces.forEach(function (poly) {
                            polys.push(poly);
                            if (poly.inner) {
                                poly.inner.forEach(function(inner) {
                                    polys.push(inner);
                                })
                            }
                        });
                        // set winding specified in output
                        POLY.setWinding(polys, process.camConventional, false);
                        printPoint = poly2polyEmit(polys, printPoint, function(poly, index, count) {
                            poly.forEachPoint(function(point, pidx, points, offset) {
                                camOut(point.clone(), offset !== 0);
                            }, true, index);
                        });
                        newLayer();
                    });
                    break;
                case PRO.ROUGH:
                case PRO.OUTLINE:
                    let dir = process.camConventional;
                    if (slice.camMode === PRO.ROUGH) {
                        setTool(process.camRoughTool, process.camRoughSpeed, process.camRoughPlunge);
                        spindle = Math.min(spindleMax, process.camRoughSpindle);
                        depthData.roughDiam = toolDiam;
                    } else {
                        setTool(process.camOutlineTool, process.camOutlineSpeed, process.camOutlinePlunge);
                        spindle = Math.min(spindleMax, process.camOutlineSpindle);
                        depthData.outlineDiam = toolDiam;
                        if (!process.camOutlinePocket) {
                            dir = !dir;
                        }
                    }
                    // todo find closest next trace/trace-point
                    slice.tops.forEach(function(top) {
                        if (!top.poly) return;
                        if (!top.traces) return;
                        let polys = [], t = [], c = [];
                        POLY.flatten(top.traces, top.inner || []).forEach(function (poly) {
                            let child = poly.parent;
                            if (depthFirst) poly = poly.clone(true);
                            if (child) c.push(poly); else t.push(poly);
                            poly.layer = depthData.layer;
                            polys.push(poly);
                        });
                        // set cut direction on outer polys
                        POLY.setWinding(t, dir);
                        // set cut direction on inner polys
                        POLY.setWinding(c, !dir);
                        if (depthFirst) {
                            (slice.camMode === PRO.ROUGH ? depthData.rough : depthData.outline).append(polys);
                        } else {
                            printPoint = poly2polyEmit(polys, printPoint, function(poly, index, count) {
                                poly.forEachPoint(function(point, pidx, points, offset) {
                                    camOut(point.clone(), offset !== 0);
                                }, poly.isClosed(), index);
                            });
                            newLayer();
                        }
                    });
                    break;
                case PRO.CONTOUR_X:
                case PRO.CONTOUR_Y:
                    if (isNewMode || !printPoint) {
                        // force start at lower left corner
                        printPoint = newPoint(bounds.min.x,bounds.min.y,zmax);
                    }
                    setTool(process.camContourTool, process.camContourSpeed, process.camFastFeedZ);
                    spindle = Math.min(spindleMax, process.camContourSpindle);
                    depthData.outlineDiam = toolDiam;
                    // todo find closest next trace/trace-point
                    slice.tops.forEach(function(top) {
                        if (!top.traces) return;
                        let polys = [], poly, emit;
                        top.traces.forEach(function (poly) {
                            if (depthFirst) poly = poly.clone(true);
                            polys.push({first:poly.first(), last:poly.last(), poly:poly});
                        });
                        if (depthFirst) {
                            (slice.camMode === PRO.CONTOUR_X ? depthData.contourx : depthData.contoury).appendAll(polys);
                        } else {
                            printPoint = tip2tipEmit(polys, printPoint, function(el, point, count) {
                                poly = el.poly;
                                if (poly.last() === point) poly.reverse();
                                poly.forEachPoint(function(point, pidx) {
                                    camOut(point.clone(), pidx > 0);
                                }, false);
                                return lastPoint;
                            });
                            newLayer();
                        }
                    });
                    break;
                case PRO.DRILL:
                    setTool(process.camDrillTool, process.camDrillDownSpeed, process.camDrillDownSpeed);
                    // drilling is always depth-first
                    slice.tops.forEach(function(top) {
                        if (!top.traces) return;
                        depthData.drill.appendAll(top.traces);
                    });
                    break;
            }
            update(sliceIndex / slices.length);
        });

        function polyEmit(poly, index, count, fromPoint) {
            let last = null;
            if (easeDown && poly.isClosed()) {
                last = poly.forEachPointEaseDown(function(point, offset) {
                    camOut(point.clone(), offset > 0);
                }, fromPoint);
            } else {
                poly.forEachPoint(function(point, pidx, points, offset) {
                    camOut(point.clone(), offset !== 0);
                }, poly.isClosed(), index);
            }
            newLayer();
            return last;
        }

        function polyLevelEmitter(start, depth, levels, tops, emitter, fit) {
            let level = levels[depth];
            if (!level) {
                return start;
            }
            let ltops = tops[depth];
            let fitted = fit ? ltops.filter(poly => poly.isInside(fit)) : ltops;
            fitted.forEach(top => {
                let inside = level.filter(poly => poly.isInside(top));
                start = poly2polyEmit(inside, start, emitter);
                start = polyLevelEmitter(start, depth + 1, levels, tops, emitter, top);
            });
            return start;
        }

        function polyArrayEmitter(levels, printPoint, emitter, info, fit) {
            let tops = levels.map(level => {
                return POLY.nest(level.filter(poly => poly.depth === 0).clone());
            });
            // start with the smallest polygon on the top
            // printPoint = levels[0]
            //     .filter(p => p.depth)
            //     .sort((a,b) => { return a.area() - b.area() })
            //     .shift()
            //     .average();
            return polyLevelEmitter(printPoint, 0, levels, tops, emitter);
        }

        // act on accumulated layer data
        if (depthFirst) {
            // roughing depth first
            if (depthData.rough.length > 0) {
                lastMode = PRO.ROUGH;
                setTool(process.camRoughTool, process.camRoughSpeed, process.camRoughPlunge);
                spindle = Math.min(spindleMax, process.camRoughSpindle);
                printPoint = polyArrayEmitter(depthData.rough, printPoint, polyEmit);
            }
            // outline depth first
            if (depthData.outline.length > 0) {
                lastMode = PRO.OUTLINE;
                setTool(process.camOutlineTool, process.camOutlineSpeed, process.camOutlinePlunge);
                spindle = Math.min(spindleMax, process.camOutlineSpindle);
                printPoint = poly2polyDepthFirstEmit(
                    depthData.outline, printPoint, polyEmit,
                    depthData.outlineDiam * 0.01);
            }
            // two modes for deferred outlining: x then y or combined
            if (process.camContourCurves) {
                lastMode = PRO.CONTOUR_X;
                setTool(process.camContourTool, process.camContourSpeed, process.camContourPlunge);
                spindle = Math.min(spindleMax, process.camContourSpindle);
                // combined deferred contour x and y outlining
                let contourxy = [].appendAll(depthData.contourx).appendAll(depthData.contoury);
                printPoint = tip2tipEmit(contourxy, printPoint, function(el, point, count) {
                    let poly = el.poly;
                    if (poly.last() === point) {
                        poly.reverse();
                    }
                    poly.forEachPoint(function(point, pidx) {
                        camOut(point.clone(), pidx > 0);
                    }, false);
                    newLayer();
                    return lastPoint;
                });
            } else {
                setTool(process.camContourTool, process.camContourSpeed, process.camContourPlunge);
                spindle = Math.min(spindleMax, process.camContourSpindle);
                // deferred contour x outlining
                if (depthData.contourx.length > 0) {
                    lastMode = PRO.CONTOUR_X;
                    // force start at lower left corner
                    // printPoint = newPoint(bounds.min.x,bounds.min.y,zmax);
                    printPoint = tip2tipEmit(depthData.contourx, printPoint, function(el, point, count) {
                        let poly = el.poly;
                        if (poly.last() === point) poly.reverse();
                        poly.forEachPoint(function(point, pidx) {
                            camOut(point.clone(), pidx > 0);
                        }, false);
                        newLayer();
                        return lastPoint;
                    });
                }
                // deferred contour y outlining
                if (depthData.contoury.length > 0) {
                    lastMode = PRO.CONTOUR_Y;
                    // force start at lower left corner
                    printPoint = tip2tipEmit(depthData.contoury, printPoint, function(el, point, count) {
                        let poly = el.poly;
                        if (poly.last() === point) poly.reverse();
                        poly.forEachPoint(function(point, pidx) {
                            camOut(point.clone(), pidx > 0);
                        }, false);
                        newLayer();
                        return lastPoint;
                    });
                }
            }
        }

        // drilling is always depth first, and always output last (change?)
        if (depthData.drill.length > 0) {
            lastMode = PRO.DRILL;
            setTool(process.camDrillTool, process.camDrillDownSpeed, process.camDrillDownSpeed);
            emitDrills(depthData.drill);
        }

        // last layer/move is to zmax
        // injected into the last layer generated
        if (lastPoint)
        addOutput(newOutput[newOutput.length-1], printPoint = lastPoint.clone().setZ(zmax_outer), 0, 0, tool.getNumber());

        // replace output single flattened layer with all points
        print.output = newOutput;

        if (widgetIndex + 1 < widgetCount) {
            printSetup(print, update, widgetIndex + 1, printPoint);
        }
    };

    /**
     * return tool Z clearance height for a line segment movement path
     */
    function getZClearPath(terrain, x1, y1, x2, y2, z, zadd, off, over) {
        let maxz = z;
        let check = [];
        for (let i=0; i<terrain.length; i++) {
            let data = terrain[i];
            check.push(data);
            if (data.z + zadd < z) {
                break;
            }
        }
        check.reverse();
        for (let i=0; i<check.length; i++) {
            let data = check[i];
            let p1 = newPoint(x1, y1);
            let p2 = newPoint(x2, y2);
            let int = data.tops.map(p => p.intersections(p1, p2, true)).flat();
            if (int.length) {
                maxz = Math.max(maxz, data.z + zadd + over);
                continue;
            }

            let s1 = p1.slopeTo(p2).toUnit().normal();
            let s2 = p2.slopeTo(p1).toUnit().normal();
            let pa = p1.projectOnSlope(s1, off);
            let pb = p2.projectOnSlope(s1, off);
            int = data.tops.map(p => p.intersections(pa, pb, true)).flat();
            if (int.length) {
                maxz = Math.max(maxz, data.z + zadd + over);
                continue;
            }
            pa = p1.projectOnSlope(s2, off);
            pb = p2.projectOnSlope(s2, off);
            int = data.tops.map(p => p.intersections(pa, pb, true)).flat();
            if (int.length) {
                maxz = Math.max(maxz, data.z + zadd + over);
                continue;
            }
        }
        return maxz;
    }

})();
