import test from 'node:test';
import assert from 'node:assert/strict';
import {TapGesture} from '../rosto3d/v2/gesture.mjs';

const event=(overrides={})=>({pointerId:1,pointerType:'mouse',button:0,buttons:1,isPrimary:true,clientX:20,clientY:20,...overrides});
function setup(){let time=0;return {gesture:new TapGesture({now:()=>time}),advance(ms){time+=ms;}};}

test('left click, primary touch and pen tap are recognized only once',()=>{
 for(const pointerType of ['mouse','touch','pen']){const {gesture,advance}=setup(),e=event({pointerType});gesture.down(e);advance(100);assert.equal(gesture.up({...e,buttons:0}),true);assert.equal(gesture.up({...e,buttons:0}),false);}
});
test('middle/right clicks and nonprimary contacts cannot mark a point',()=>{
 for(const overrides of [{button:1,buttons:4},{button:2,buttons:2},{isPrimary:false,pointerType:'touch'}]){const {gesture}=setup(),e=event(overrides);gesture.down(e);assert.equal(gesture.up({...e,buttons:0}),false);gesture.down(event());assert.equal(gesture.up(event({buttons:0})),true);}
});
test('drag that returns to the original position is not a tap',()=>{
 const {gesture}=setup();gesture.down(event());gesture.move(event({clientX:80,clientY:80}));gesture.move(event());assert.equal(gesture.up(event({buttons:0})),false);
});
test('movement threshold uses maximum two-dimensional displacement and includes pointerup',()=>{
 for(const [x,y,expected] of [[26,20,true],[26.01,20,false],[24.3,24.3,false]]){const {gesture}=setup();gesture.down(event());assert.equal(gesture.up(event({clientX:x,clientY:y,buttons:0})),expected);}
});
test('a long press does not mark a point',()=>{
 for(const [duration,expected] of [[550,true],[551,false]]){const {gesture,advance}=setup();gesture.down(event());advance(duration);assert.equal(gesture.up(event({buttons:0})),expected);}
});
test('pinch rejects both lifts in either order and permits the next single tap',()=>{
 for(const reverse of [false,true]){const {gesture}=setup(),first=event({pointerType:'touch'}),second=event({pointerType:'touch',pointerId:2,isPrimary:false});gesture.down(first);gesture.down(second);for(const e of reverse?[second,first]:[first,second])assert.equal(gesture.up({...e,buttons:0}),false);gesture.down(first);assert.equal(gesture.up({...first,buttons:0}),true);}
});
test('cancelled contact or lost pointer capture cannot become a tap',()=>{
 const {gesture}=setup();gesture.down(event());gesture.cancel(event());assert.equal(gesture.up(event({buttons:0})),false);gesture.down(event());assert.equal(gesture.up(event({buttons:0})),true);
});
test('clear on mode/context change discards all pending contacts',()=>{
 const {gesture}=setup();gesture.down(event());gesture.down(event({pointerId:2,isPrimary:false}));gesture.clear();assert.equal(gesture.up(event({buttons:0})),false);assert.equal(gesture.up(event({pointerId:2,buttons:0})),false);gesture.down(event());assert.equal(gesture.up(event({buttons:0})),true);
});
test('adding a mouse button during a press invalidates the gesture',()=>{
 const {gesture}=setup();gesture.down(event());gesture.move(event({buttons:3}));gesture.move(event());assert.equal(gesture.up(event({buttons:0})),false);
});
