// A tap must remain short and stationary for its entire lifetime, not just end
// near its starting point. Track all contacts so a pinch can never become a tap.
export class TapGesture {
 constructor({now=()=>performance.now(),maxDistance=6,maxDuration=550}={}){this.now=now;this.maxDistance=maxDistance;this.maxDuration=maxDuration;this.clear();}
 down(e){
  this.active.add(e.pointerId);
  if(this.active.size>1){this.multi=true;this.start=null;return;}
  if(e.button!==0||!e.isPrimary||e.buttons!==undefined&&e.buttons!==1){this.start=null;return;}
  this.start={id:e.pointerId,x:e.clientX,y:e.clientY,max:0,time:this.now()};
 }
 displacement(e){if(this.start?.id===e.pointerId)this.start.max=Math.max(this.start.max,Math.hypot(e.clientX-this.start.x,e.clientY-this.start.y));}
 move(e){this.displacement(e);if(this.start?.id===e.pointerId&&e.buttons!==undefined&&e.buttons!==1)this.start=null;}
 up(e){this.displacement(e);const tap=Boolean(e.button===0&&!this.multi&&this.start?.id===e.pointerId&&this.start.max<=this.maxDistance&&this.now()-this.start.time<=this.maxDuration);this.cancel(e);return tap;}
 cancel(e){this.active.delete(e.pointerId);if(this.start?.id===e.pointerId)this.start=null;if(!this.active.size)this.multi=false;}
 clear(){this.active=new Set();this.start=null;this.multi=false;}
}
